/**
 * Dev Workflow 命令: /qdev, /idea, /commit, /merge
 * 开发工作流快捷命令，通过 Skill 文件或 Claude 后台进程执行
 */

import { randomUUID } from 'crypto';
import { basename } from 'path';
import {
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { qdevCore } from '../../utils/qdev-core.js';
import { logger } from '../../utils/logger.js';
import { EmbedColors, MessagePriority } from '../message-queue.js';
import { StateManager } from '../state.js';
import { getDb } from '../../db/index.js';
import { IdeaRepository } from '../../db/idea-repo.js';
import { buildIdeaPromoteButtons } from '../idea-buttons.js';
import { MODEL_OPTIONS } from './task.js';
import type { Idea } from '../../types/repository.js';
import { IdeaStatus, IdeaType } from '../../types/repository.js';
import type { CommandDeps } from './types.js';
import { requireAuth, requireThread } from './utils.js';

export const devCommands = [
  new SlashCommandBuilder()
    .setName('qdev')
    .setDescription('Quick Dev: create branch + task + start Claude')
    .addStringOption(opt =>
      opt.setName('description').setDescription('Task description').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('model').setDescription('Claude model to use')
        .addChoices(...MODEL_OPTIONS.map(m => ({ name: m.label, value: m.id })))
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt.setName('worktree')
        .setDescription('Create new worktree (default: false). True to fork a new branch + worktree.')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('code-audit')
    .setDescription('Run code audit in a new channel (reuses current worktree)')
    .addStringOption(opt =>
      opt.setName('model').setDescription('Claude model to use (defaults to current channel setting)')
        .addChoices(...MODEL_OPTIONS.map(m => ({ name: m.label, value: m.id })))
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('idea')
    .setDescription('Record an idea or develop an existing one')
    .addStringOption(opt =>
      opt.setName('content').setDescription('Idea content (empty to list existing ideas)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('commit')
    .setDescription('Review and commit code changes')
    .addStringOption(opt =>
      opt.setName('message').setDescription('Optional commit message hint').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('merge')
    .setDescription('Merge worktree branch to main and cleanup')
    .addStringOption(opt =>
      opt.setName('target').setDescription('Thread name or branch name to merge').setRequired(true)
    ),
];

export async function handleDevCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'qdev':
      return handleQdev(interaction, deps);
    case 'code-audit':
      return handleCodeAudit(interaction, deps);
    case 'idea':
      return handleIdea(interaction, deps);
    case 'commit':
      return handleCommit(interaction, deps);
    case 'merge':
      return handleMerge(interaction, deps);
  }
}

// ========== /qdev ==========

async function handleQdev(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const description = interaction.options.getString('description', true);
  const model = interaction.options.getString('model') || undefined;
  const worktree = interaction.options.getBoolean('worktree') ?? false;
  const { stateManager, client, config, messageHandler } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply('Creating task...');

  try {
    // 从当前 channel 的 parentId 获取 Category
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

    const result = await qdevCore({
      guildId,
      channelId,
      description,
      model,
      categoryId,
      worktree,
    }, {
      stateManager,
      client,
      worktreesDir: config.worktreesDir,
      channelService: deps.channelService,
    });

    // 触发 Claude 处理（fire-and-forget）
    messageHandler.handleBackgroundChat(guildId, result.channelId, description, 'qdev').catch((err) => {
      logger.error('qdev background chat failed:', err);
    });

    const replyLines = ['**Task created**\n'];
    if (worktree && result.branchName) {
      replyLines.push(`Branch: \`${result.branchName}\``);
    }
    replyLines.push(`Thread: <#${result.channelId}>`);
    replyLines.push(`Working directory: \`${result.cwd}\``);
    replyLines.push('\nClaude is processing the task in the new thread...');
    await interaction.editReply(replyLines.join('\n'));
  } catch (error: any) {
    logger.error('qdev failed:', error);
    await interaction.editReply(`qdev failed: ${error.message}`);
  }
}

// ========== /code-audit ==========

async function handleCodeAudit(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const model = interaction.options.getString('model') || undefined;
  const { stateManager, client, config, messageHandler } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply('Creating code audit channel...');

  try {
    // 从当前 channel 的 parentId 获取 Category
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

    const auditChannelName = `审计:${session.name || channelId.slice(-6)}`;
    const auditPrompt = '/code-audit';

    const result = await qdevCore({
      guildId,
      channelId,
      description: auditPrompt,
      model: model || session.model || undefined,
      categoryId,
      channelName: auditChannelName,
      worktree: false,
    }, {
      stateManager,
      client,
      worktreesDir: config.worktreesDir,
      channelService: deps.channelService,
    });

    // 触发 Claude 执行代码审查（fire-and-forget）
    messageHandler.handleBackgroundChat(guildId, result.channelId, auditPrompt, 'code-audit').catch((err) => {
      logger.error('code-audit background chat failed:', err);
    });

    await interaction.editReply(
      `**Code audit started**\n` +
      `Thread: <#${result.channelId}>\n` +
      `Working directory: \`${result.cwd}\``
    );
  } catch (error: any) {
    logger.error('code-audit failed:', error);
    await interaction.editReply(`code-audit failed: ${error.message}`);
  }
}

// ========== /idea ==========

async function handleIdea(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const args = interaction.options.getString('content') || '';
  const { stateManager, messageQueue } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  if (args) {
    // 记录模式：直接写入数据库
    await interaction.reply('Recording idea...');
    try {
      const project = projectFromCwd(session.cwd);
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10); // yyyy-MM-dd
      const idea: Idea = {
        id: randomUUID(),
        name: args,
        status: IdeaStatus.Idea,
        type: IdeaType.Manual,
        project,
        date: today,
        body: null,
        createdAt: now,
        updatedAt: now,
      };
      const db = getDb();
      const ideaRepo = new IdeaRepository(db);
      await ideaRepo.save(idea);
      await messageQueue.send(channelId, `Idea recorded: **${args}**\nProject: \`${project}\``, {
        embedColor: EmbedColors.GREEN,
        priority: MessagePriority.High,
      });
    } catch (err: any) {
      logger.error('idea record failed:', err);
      await messageQueue.sendLong(channelId, `idea record failed: ${err.message}`).catch(() => {});
    }
  } else {
    // 列表模式：直接查询数据库，Embed + 按钮展示
    await interaction.reply('Querying ideas...');

    try {
      const db = getDb();
      const ideaRepo = new IdeaRepository(db);
      const ideas = await ideaRepo.findByStatus(IdeaStatus.Idea);

      if (ideas.length === 0) {
        await messageQueue.send(channelId, 'No undeveloped ideas found.', {
          embedColor: EmbedColors.GRAY,
          priority: MessagePriority.High,
        });
        return;
      }

      const lines = ideas.map((idea, i) =>
        `**${i + 1}.** ${idea.name}\n` +
        `   Project: \`${idea.project}\` | Date: ${idea.date}`
      );
      const description = lines.join('\n\n');
      const rows = buildIdeaPromoteButtons(ideas);

      await messageQueue.send(
        channelId,
        `**Ideas** (${ideas.length} undeveloped)\n\n${description}`,
        {
          components: rows as any,
          embedColor: EmbedColors.PURPLE,
          priority: MessagePriority.High,
        },
      );
    } catch (err: any) {
      logger.error('idea list mode failed:', err);
      await messageQueue.sendLong(channelId, `idea query failed: ${err.message}`).catch(() => {});
    }
  }
}

// ========== /commit ==========

async function handleCommit(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const message = interaction.options.getString('message') || '';
  const { stateManager, messageHandler, messageQueue } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  const prompt = message ? `/commit ${message}` : '/commit';

  await interaction.reply({
    content: `Reviewing and committing code...${message ? `\nHint: ${message}` : ''}`,
    ephemeral: true,
  });

  messageHandler.handleBackgroundChat(guildId, channelId, prompt, 'commit').catch((err) => {
    logger.error('commit failed:', err);
    messageQueue.sendLong(channelId, `commit failed: ${err.message}`).catch(() => {});
  });
}

// ========== /merge ==========

async function handleMerge(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;

  const guildId = interaction.guildId!;
  const target = interaction.options.getString('target', true);
  const { stateManager, claudeClient, messageHandler, messageQueue } = deps;

  // 查找匹配的 session
  const allSessions = stateManager.getAllSessions(guildId);
  const targetSession = allSessions.find(s => s.worktreeBranch === target)
    || allSessions.find(s => s.name === target)
    || allSessions.find(s => s.name.toLowerCase().includes(target.toLowerCase()));

  if (!targetSession) {
    await interaction.reply({ content: `No matching thread found: "${target}"`, ephemeral: true });
    return;
  }

  if (!targetSession.worktreeBranch) {
    await interaction.reply({ content: `Thread "${targetSession.name}" is not a worktree branch, cannot merge.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // 预计算 main worktree 路径
  let mainCwd: string;
  try {
    const { execGit } = await import('../../orchestrator/git-ops.js');
    const stdout = await execGit(['worktree', 'list'], targetSession.cwd, 'merge: list worktrees');
    const mainLine = stdout.split('\n').find(line => /\[(main|master)\]/.test(line));
    if (!mainLine) {
      await interaction.editReply('Cannot find main/master branch worktree.');
      return;
    }
    mainCwd = mainLine.split(/\s+/)[0];
  } catch (err: any) {
    await interaction.editReply(`Failed to resolve main worktree: ${err.message}`);
    return;
  }

  // 使用原生 skill：/merge <branch>
  const prompt = `/merge ${targetSession.worktreeBranch}`;

  // Step 1: 停止 target session 正在运行的 Claude 进程
  const targetLockKey = StateManager.channelLockKey(guildId, targetSession.channelId);
  const wasRunning = claudeClient.abort(targetLockKey);
  if (wasRunning) {
    logger.info(`[merge] Stopped target session: ${targetSession.name}`);
  }

  // Step 2: 清除旧 session，设置 cwd 为 main worktree（等同于 /clear + 改 cwd）
  stateManager.clearSessionClaudeId(guildId, targetSession.channelId);
  stateManager.setSessionCwd(guildId, targetSession.channelId, mainCwd);

  await interaction.editReply(
    `Merging: **${targetSession.name}**\n` +
    `Branch: \`${targetSession.worktreeBranch}\`\n` +
    `Executing in: <#${targetSession.channelId}>`
  );

  // Step 3: 在 target session 中用全新 Claude 执行 merge
  // merge skill 最后会通过 MCP bot_tasks(action="delete") 删除 channel 和 session
  messageHandler.handleBackgroundChat(guildId, targetSession.channelId, prompt, 'merge').catch((err) => {
    logger.error('merge failed:', err);
    messageQueue.sendLong(targetSession.channelId, `merge failed: ${err.message}`).catch(() => {});
  });
}

// ========== helpers ==========

/** cwd → project name */
function projectFromCwd(cwd: string): string {
  if (cwd.includes('claude-bot')) return 'claude-bot';
  if (cwd.includes('LearnFlashy')) return 'LearnFlashy';
  return basename(cwd);
}


