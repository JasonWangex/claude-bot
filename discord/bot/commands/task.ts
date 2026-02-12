/**
 * Task 管理命令: /task, /close, /info, /cd
 * /task — 创建 Category + Text Channel
 * /close — 关闭当前 task channel 并清理 worktree/分支
 * /info — 查看当前线程详情
 * /cd — 切换工作目录
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { EmbedColors } from '../message-queue.js';
import { resolve } from 'path';
import { stat } from 'fs/promises';
import { escapeMarkdown } from '../message-utils.js';
import { StateManager } from '../state.js';
import { logger } from '../../utils/logger.js';
import {
  normalizeTopicName,
  resolveTopicWorkDir,
  ensureProjectDir,
  resolveCustomPath,
} from '../../utils/topic-path.js';
import type { CommandDeps } from './types.js';
import { requireAuth, requireThread } from './utils.js';

export const MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

export const taskCommands = [
  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Create a new task (Text Channel under Category)')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Task name').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('path').setDescription('Custom working directory path').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('category').setDescription('Category name (defaults to repo name)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close current task channel and cleanup worktree/branch')
    .addBooleanOption(opt =>
      opt.setName('force').setDescription('Force close without safety checks').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('info')
    .setDescription('View current channel details or server info'),

  new SlashCommandBuilder()
    .setName('cd')
    .setDescription('Change or view working directory')
    .addStringOption(opt =>
      opt.setName('path').setDescription('New working directory path').setRequired(false)
    ),
];

export async function handleTaskCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'task':
      return handleTask(interaction, deps);
    case 'close':
      return handleClose(interaction, deps);
    case 'info':
      return handleInfo(interaction, deps);
    case 'cd':
      return handleCd(interaction, deps);
  }
}

// ========== /task ==========

async function handleTask(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;

  const guildId = interaction.guildId!;
  const { stateManager, client, config } = deps;

  const taskName = interaction.options.getString('name', true);
  const customCwd = interaction.options.getString('path');
  const categoryName = interaction.options.getString('category');

  await interaction.deferReply();

  try {
    // 解析工作目录
    let cwd: string;
    let dirCreated = false;

    if (customCwd) {
      cwd = resolveCustomPath(customCwd, stateManager.getGuildDefaultCwd(guildId));
      const dirResult = await ensureProjectDir(cwd, config.autoCreateProjectDir);
      dirCreated = dirResult.created;

      if (!dirResult.exists && !config.autoCreateProjectDir) {
        await interaction.editReply(
          `Directory does not exist: \`${cwd}\`\n\n` +
          `Create it first, or set AUTO_CREATE_PROJECT_DIR=true.`
        );
        return;
      }
    } else {
      const occupiedPaths = stateManager.getOccupiedWorkDirs(guildId);
      cwd = await resolveTopicWorkDir(
        taskName,
        config.projectsRoot,
        config.topicDirNaming,
        occupiedPaths,
      );
      const dirResult = await ensureProjectDir(cwd, config.autoCreateProjectDir);
      dirCreated = dirResult.created;

      if (!dirResult.exists && !config.autoCreateProjectDir) {
        await interaction.editReply(
          `Resolved directory does not exist: \`${cwd}\`\n\n` +
          `Use \`/task ${taskName} <path>\` to specify manually,\n` +
          `or set AUTO_CREATE_PROJECT_DIR=true.`
        );
        return;
      }
    }

    // 查找或创建 Category
    const guild = await client.guilds.fetch(guildId);
    const targetCategoryName = categoryName || getCategoryNameFromCwd(cwd);
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === targetCategoryName,
    );

    if (!category) {
      category = await guild.channels.create({
        name: targetCategoryName,
        type: ChannelType.GuildCategory,
        reason: `Auto-created by Claude Bot for project: ${targetCategoryName}`,
      });
      logger.info(`Created Category: ${targetCategoryName}`);
    }

    // 创建 Text Channel (under Category)
    const textChannel = await guild.channels.create({
      name: taskName.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `Task: ${taskName}`,
    });

    // 发送初始消息
    const initEmbed = new EmbedBuilder()
      .setColor(EmbedColors.PURPLE)
      .setDescription(`[task] Task created: \`${taskName}\`\nWorking directory: \`${cwd}\`${dirCreated ? '\nDirectory auto-created' : ''}`.slice(0, 4096));
    await textChannel.send({ embeds: [initEmbed] });

    // 初始化 Session
    stateManager.getOrCreateSession(guildId, textChannel.id, {
      name: taskName,
      cwd,
    });

    await interaction.editReply(
      `**Task created:** ${taskName}\n` +
      `Channel: <#${textChannel.id}>\n` +
      `Working directory: \`${cwd}\`${dirCreated ? '\nDirectory auto-created' : ''}`
    );
  } catch (error: any) {
    logger.error('Failed to create task:', error);
    await interaction.editReply(`Failed to create task: ${error.message}`);
  }
}

// ========== /close ==========

async function handleClose(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const threadId = interaction.channelId;
  const force = interaction.options.getBoolean('force') ?? false;
  const { stateManager, claudeClient } = deps;

  const session = stateManager.getSession(guildId, threadId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // 检查是否有运行中的 Claude 进程
  const lockKey = StateManager.threadLockKey(guildId, threadId);
  if (claudeClient.isRunning(lockKey)) {
    await interaction.editReply('Cannot close: a Claude task is still running. Use `/stop` first.');
    return;
  }

  // 安全检查（除非 --force）
  if (session.worktreeBranch && !force) {
    const { hasUncommittedChanges, isBranchMerged } = await import('../../utils/git-utils.js');

    try {
      const hasChanges = await hasUncommittedChanges(session.cwd);
      if (hasChanges) {
        await interaction.editReply(
          `Cannot close: worktree has uncommitted changes.\n` +
          `Working directory: \`${session.cwd}\`\n\n` +
          `Commit or stash your changes first, or use \`/close force:True\` to force.`
        );
        return;
      }

      const merged = await isBranchMerged(session.cwd, session.worktreeBranch);
      if (!merged) {
        await interaction.editReply(
          `Cannot close: branch \`${session.worktreeBranch}\` has unmerged commits.\n\n` +
          `Merge the branch first, or use \`/close force:True\` to force.`
        );
        return;
      }
    } catch (err: any) {
      await interaction.editReply(
        `Safety check failed: ${err.message}\n\n` +
        `Cannot verify worktree/branch state. Use \`/close force:True\` to force close.`
      );
      return;
    }
  }

  // 清理 worktree 和分支（force 跳过安全检查但仍执行清理）
  if (session.worktreeBranch) {
    try {
      const { removeWorktree, deleteBranch } = await import('../../utils/git-utils.js');
      const { resolveMainWorktree } = await import('../../orchestrator/git-ops.js');
      const mainCwd = await resolveMainWorktree(session.cwd);
      await removeWorktree(mainCwd, session.cwd);
      await deleteBranch(mainCwd, session.worktreeBranch).catch(() => {});
    } catch (err: any) {
      logger.warn(`Cleanup warning: ${err.message}`);
    }
  }

  // 归档 session
  stateManager.archiveSession(guildId, threadId);

  // 先回复再删除 channel
  await interaction.editReply(`Channel closing: **${escapeMarkdown(session.name)}**`);

  // 延迟后删除 channel（让用户看到回复）
  const channel = interaction.channel;
  if (channel && 'delete' in channel) {
    await new Promise(r => setTimeout(r, 1500));
    await (channel as any).delete('Task closed').catch((err: any) => {
      logger.warn(`Channel delete failed: ${err.message}`);
    });
  }
}

// ========== /info ==========

async function handleInfo(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  const { stateManager } = deps;
  const guildId = interaction.guildId!;

  const channelId = interaction.channelId;
  const session = stateManager.getSession(guildId, channelId);

  if (session) {
    const created = new Date(session.createdAt).toLocaleString('zh-CN');
    const lastMsgTime = session.lastMessageAt
      ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
      : 'None';
    const modelLabel = getModelLabel(session.model);

    await interaction.reply(
      `**Channel Details**\n\n` +
      `Channel: \`${escapeMarkdown(session.name)}\`\n` +
      `Working directory: \`${escapeMarkdown(session.cwd)}\`\n` +
      `Model: ${escapeMarkdown(modelLabel)}\n` +
      `Claude context: ${session.claudeSessionId ? `\`${session.claudeSessionId}\`` : '(new session)'}\n` +
      `Created: ${created}\n` +
      `Last activity: ${lastMsgTime}\n` +
      `Messages: ${session.messageHistory.length}`
    );
  } else {
    // General: show server info
    const uptime = process.uptime();
    const uptimeStr = formatUptime(uptime);
    const memUsage = process.memoryUsage();

    await interaction.reply(
      `**Server Info**\n\n` +
      `Uptime: ${uptimeStr}\n` +
      `Node.js: ${process.version}\n` +
      `PID: ${process.pid}\n` +
      `Memory: ${Math.round(memUsage.rss / 1024 / 1024)} MB`
    );
  }
}

// ========== /cd ==========

async function handleCd(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const threadId = interaction.channelId;
  const { stateManager } = deps;
  const channelName = (interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null) ?? `channel-${threadId}`;

  const session = stateManager.getOrCreateSession(guildId, threadId, {
    name: channelName,
    cwd: stateManager.getGuildDefaultCwd(guildId),
  });

  const path = interaction.options.getString('path');

  if (!path) {
    await interaction.reply(`Current working directory: \`${escapeMarkdown(session.cwd)}\``);
    return;
  }

  const resolvedPath = resolve(session.cwd, path);

  try {
    const s = await stat(resolvedPath);
    if (!s.isDirectory()) {
      await interaction.reply({ content: `Not a directory: \`${resolvedPath}\``, ephemeral: true });
      return;
    }
    stateManager.setSessionCwd(guildId, threadId, resolvedPath);
    await interaction.reply(`Working directory changed to: \`${escapeMarkdown(resolvedPath)}\``);
  } catch {
    await interaction.reply({ content: `Directory does not exist: \`${resolvedPath}\``, ephemeral: true });
  }
}

// ========== Helpers ==========

function getCategoryNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || 'tasks';
}

export function getModelLabel(model: string | undefined): string {
  if (!model) return 'Sonnet 4.5 (default)';
  const found = MODEL_OPTIONS.find(m => m.id === model);
  return found ? found.label : model;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
