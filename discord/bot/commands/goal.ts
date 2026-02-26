/**
 * Goal 命令: /goal
 * 管理开发目标，支持子任务拆解、进度跟踪和方向变更。
 * newSession=true 时先 fork（创建 worktree + channel），再在新 session 中执行 goal skill。
 */

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
  const channelId = interaction.channelId;
  const text = interaction.options.getString('text') || '';
  const newSession = interaction.options.getBoolean('new_session') ?? false;
  const { stateManager, client, config, messageHandler, messageQueue } = deps;

  const session = stateManager.getSession(guildId, channelId);
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
      const collectingGoals = await goalMetaRepo.findByStatus('Collecting');
      const plannedGoals = await goalMetaRepo.findByStatus('Planned');
      const processingGoals = await goalMetaRepo.findByStatus('Processing');
      const blockingGoals = await goalMetaRepo.findByStatus('Blocking');
      const allGoals = [...collectingGoals, ...plannedGoals, ...processingGoals, ...blockingGoals];

      if (allGoals.length === 0) {
        await messageQueue.send(channelId, 'No active goals found.', {
          embedColor: EmbedColors.GRAY,
          priority: 'high',
        });
        return;
      }

      const statusEmoji: Record<string, string> = {
        Collecting: '\u{1F4AC}',
        Planned: '\u{1F4CB}',
        Processing: '\u{1F7E2}',
        Blocking: '\u{1F6A7}',
      };

      const lines = allGoals.map((goal, i) => {
        const emoji = statusEmoji[goal.status] || '\u26AA';
        let line = `**${i + 1}.** ${emoji} ${goal.name}`;
        if (goal.progress) {
          try {
            const p = JSON.parse(goal.progress);
            if (typeof p.completed === 'number' && typeof p.total === 'number') {
              line += `\n   Progress: ${p.completed}/${p.total} 完成`;
              if (p.running > 0) line += `, ${p.running} 进行中`;
              if (p.failed > 0) line += `, ${p.failed} 失败`;
            } else {
              line += `\n   Progress: ${goal.progress}`;
            }
          } catch {
            line += `\n   Progress: ${goal.progress}`;
          }
        }
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
        channelId,
        `**Goals** (${allGoals.length} active)\n\n${description}`,
        {
          components: rows as any,
          embedColor: EmbedColors.PURPLE,
          priority: 'high',
        },
      );
    } catch (err: any) {
      logger.error('goal list mode failed:', err);
      await messageQueue.sendLong(channelId, `goal query failed: ${err.message}`).catch(() => {});
    }
    return;
  }

  if (!newSession) {
    // 有参数，当前 session：通过原生 skill 转发给 Claude
    const prompt = text ? `/goal ${text}` : '/goal';
    await interaction.reply(`Goal: ${text}...`);
    messageHandler.handleBackgroundChat(guildId, channelId, prompt, 'goal').catch((err) => {
      logger.error('goal failed:', err);
      messageQueue.sendLong(channelId, `goal failed: ${err.message}`).catch(() => {});
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
    const rootSession = stateManager.getRootSession(guildId, channelId);
    const parentChannelId = rootSession?.channelId ?? channelId;

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
    const forkResult = await forkTaskCore(guildId, parentChannelId, branchName, categoryId, {
      stateManager,
      client,
      worktreesDir: config.worktreesDir,
      channelService: deps.channelService,
    }, threadTitle);

    // 5. 发送 goal 描述到新 channel
    await interaction.editReply(`Branch: \`${branchName}\`\nSending goal to new thread...`);
    const newChannel = await client.channels.fetch(forkResult.channelId);
    if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
      const descEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[goal] ${text || 'Goal management'}`.slice(0, 4096));
      await (newChannel as any).send({ embeds: [descEmbed] });
    }

    // 6. 在新 session 中触发 goal skill
    const goalPrompt = text ? `/goal ${text}` : '/goal';
    messageHandler.handleBackgroundChat(guildId, forkResult.channelId, goalPrompt, 'goal').catch((err) => {
      logger.error('goal (new session) background chat failed:', err);
    });

    // 7. 最终结果
    await interaction.editReply(
      `**Goal session created**\n\n` +
      `Branch: \`${forkResult.branchName}\`\n` +
      `Thread: <#${forkResult.channelId}>\n` +
      `Working directory: \`${forkResult.cwd}\`\n\n` +
      `Claude is processing the goal in the new thread...`
    );
  } catch (error: any) {
    logger.error('goal (new session) failed:', error);
    await interaction.editReply(`goal failed: ${error.message}`);
  }
}
