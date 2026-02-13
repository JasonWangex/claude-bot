/**
 * Goal 命令: /goal
 * 管理开发目标，支持子任务拆解、进度跟踪和方向变更。
 * newSession=true 时先 fork（创建 worktree + channel），再在新 session 中执行 goal skill。
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { generateBranchName } from '../../utils/git-utils.js';
import { generateTopicTitle } from '../../utils/llm.js';
import { forkTaskCore } from '../../utils/fork-task.js';
import { logger } from '../../utils/logger.js';
import { EmbedColors } from '../message-queue.js';
import { getDb } from '../../db/index.js';
import { GoalMetaRepo } from '../../db/goal-meta-repo.js';
import type { CommandDeps } from './types.js';
import { requireAuth, requireThread } from './utils.js';

export const goalCommands = [
  new SlashCommandBuilder()
    .setName('goal')
    .setDescription('Manage development goals: create, continue, or list')
    .addStringOption(opt =>
      opt.setName('text').setDescription('Goal description or name to search').setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('new_session').setDescription('Fork a new session before executing (default: false)').setRequired(false)
    ),
];

export async function handleGoalCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'goal':
      return handleGoal(interaction, deps);
  }
}

async function handleGoal(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const threadId = interaction.channelId;
  const text = interaction.options.getString('text') || '';
  const newSession = interaction.options.getBoolean('new_session') ?? false;
  const { stateManager, client, config, messageHandler, messageQueue } = deps;

  const session = stateManager.getSession(guildId, threadId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  // 列表模式：无参数 + 当前 session → 直接查 DB 展示
  if (!newSession && !text) {
    await interaction.reply('Querying goals...');

    try {
      const db = getDb();
      const goalMetaRepo = new GoalMetaRepo(db);
      const activeGoals = await goalMetaRepo.findByStatus('Active');
      const processingGoals = await goalMetaRepo.findByStatus('Processing');
      const pausedGoals = await goalMetaRepo.findByStatus('Paused');
      const allGoals = [...activeGoals, ...processingGoals, ...pausedGoals];

      if (allGoals.length === 0) {
        await messageQueue.send(threadId, 'No active goals found.', {
          embedColor: EmbedColors.GRAY,
          priority: 'high',
        });
        return;
      }

      const statusEmoji: Record<string, string> = {
        Active: '\u{1F7E2}',
        Processing: '\u{1F535}',
        Paused: '\u23F8\uFE0F',
      };

      const lines = allGoals.map((goal, i) => {
        const emoji = statusEmoji[goal.status] || '\u26AA';
        let line = `**${i + 1}.** ${emoji} ${goal.name}`;
        if (goal.progress) line += `\n   Progress: ${goal.progress}`;
        if (goal.next) line += `\n   Next: ${goal.next}`;
        if (goal.project) line += `\n   Project: \`${goal.project}\``;
        return line;
      });

      const description = lines.join('\n\n');

      // 构建「推进」按钮（最多 5 个，一行一个）
      const buttons = allGoals.slice(0, 5).map((goal, i) =>
        new ButtonBuilder()
          .setCustomId(`goal:drive_prompt:${goal.id}`)
          .setLabel(`${i + 1}. 推进`)
          .setStyle(ButtonStyle.Primary),
      );
      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let j = 0; j < buttons.length; j += 5) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(j, j + 5)));
      }

      await messageQueue.send(
        threadId,
        `**Goals** (${allGoals.length} active)\n\n${description}`,
        {
          components: rows as any,
          embedColor: EmbedColors.PURPLE,
          priority: 'high',
        },
      );
    } catch (err: any) {
      logger.error('goal list mode failed:', err.message);
      await messageQueue.sendLong(threadId, `goal query failed: ${err.message}`).catch(() => {});
    }
    return;
  }

  // 以下路径需要加载 goal skill
  const skillPath = join(homedir(), '.claude/skills/goal/SKILL.md');
  let skillContent: string;
  try {
    skillContent = await readFile(skillPath, 'utf-8');
  } catch {
    await interaction.reply({ content: 'Skill file not found: ~/.claude/skills/goal/SKILL.md', ephemeral: true });
    return;
  }

  const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  const promptTemplate = (bodyMatch ? bodyMatch[1] : skillContent)
    .replace('{{SKILL_ARGS}}', text);

  if (!newSession) {
    // 有参数，当前 session：转发给 Claude
    const prompt = promptTemplate.replace('{{THREAD_ID}}', threadId);
    await interaction.reply(`Goal: ${text}...`);
    messageHandler.handleBackgroundChat(guildId, threadId, prompt).catch((err) => {
      logger.error('goal failed:', err.message);
      messageQueue.sendLong(threadId, `goal failed: ${err.message}`).catch(() => {});
    });
    return;
  }

  // newSession=true: 先 fork（qdev 逻辑），再在新 session 中执行 goal
  await interaction.deferReply();

  try {
    const description = text || 'goal management';

    // 1. 并行生成分支名和 thread 标题
    await interaction.editReply('Generating branch name...');
    const [branchName, threadTitle] = await Promise.all([
      generateBranchName(description),
      generateTopicTitle(description),
    ]);

    // 2. 获取 root session
    await interaction.editReply(`Branch: \`${branchName}\`\nCreating worktree and thread...`);
    const rootSession = stateManager.getRootSession(guildId, threadId);
    const parentThreadId = rootSession?.threadId ?? threadId;

    // 3. 从当前 channel 的 parentId 获取 Category
    const channel = interaction.channel;
    let categoryId: string | undefined;
    if (channel && 'parentId' in channel && channel.parentId) {
      const parent = await client.channels.fetch(channel.parentId);
      if (parent && parent.type === ChannelType.GuildCategory) {
        categoryId = parent.id;
      }
    }
    if (!categoryId) {
      await interaction.editReply('This command must be used in a task channel (under a Category).');
      return;
    }

    // 4. Fork: 创建 worktree + Text Channel + session
    const forkResult = await forkTaskCore(guildId, parentThreadId, branchName, categoryId, {
      stateManager,
      client,
      worktreesDir: config.worktreesDir,
    }, threadTitle);

    // 5. 发送 goal 描述到新 channel
    await interaction.editReply(`Branch: \`${branchName}\`\nSending goal to new thread...`);
    const newChannel = await client.channels.fetch(forkResult.threadId);
    if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
      const descEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[goal] ${text || 'Goal management'}`.slice(0, 4096));
      await (newChannel as any).send({ embeds: [descEmbed] });
    }

    // 6. 在新 session 中触发 goal skill（注入新 channel 的 thread ID）
    const prompt = promptTemplate.replace('{{THREAD_ID}}', forkResult.threadId);
    messageHandler.handleBackgroundChat(guildId, forkResult.threadId, prompt).catch((err) => {
      logger.error('goal (new session) background chat failed:', err.message);
    });

    // 7. 最终结果
    await interaction.editReply(
      `**Goal session created**\n\n` +
      `Branch: \`${forkResult.branchName}\`\n` +
      `Thread: <#${forkResult.threadId}>\n` +
      `Working directory: \`${forkResult.cwd}\`\n\n` +
      `Claude is processing the goal in the new thread...`
    );
  } catch (error: any) {
    logger.error('goal (new session) failed:', error);
    await interaction.editReply(`goal failed: ${error.message}`);
  }
}
