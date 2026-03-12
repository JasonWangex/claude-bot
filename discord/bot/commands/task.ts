/**
 * Task 管理命令: /close, /info, /cd
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
  { id: process.env.PIPELINE_SONNET_MODEL || 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: process.env.PIPELINE_OPUS_MODEL || 'claude-opus-4-6', label: 'Opus 4.6' },
];

export const taskCommands = [
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
    case 'close':
      return handleClose(interaction, deps);
    case 'info':
      return handleInfo(interaction, deps);
    case 'cd':
      return handleCd(interaction, deps);
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
  const channelId = interaction.channelId;
  const force = interaction.options.getBoolean('force') ?? false;
  const { stateManager, claudeClient } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // 检查是否有运行中的 Claude 进程
  const lockKey = StateManager.channelLockKey(guildId, channelId);
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
  stateManager.archiveSession(guildId, channelId);

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

    const effortLabel = session.effort ?? 'default';
    const branchLabel = session.worktreeBranch ?? 'main';

    await interaction.reply(
      `**Channel Details**\n\n` +
      `Channel: \`${escapeMarkdown(session.name)}\`\n` +
      `Working directory: \`${escapeMarkdown(session.cwd)}\`\n` +
      `Branch: \`${escapeMarkdown(branchLabel)}\`\n` +
      `Model: ${escapeMarkdown(modelLabel)} | Effort: ${escapeMarkdown(effortLabel)}\n` +
      `Claude context: ${session.claudeSessionId ? `\`${session.claudeSessionId}\`` : '(new session)'}\n` +
      `Created: ${created}\n` +
      `Last activity: ${lastMsgTime}\n` +
      `Messages: ${session.messageCount}`
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
  const channelId = interaction.channelId;
  const { stateManager } = deps;
  const channelName = (interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null) ?? `channel-${channelId}`;

  const session = stateManager.getOrCreateSession(guildId, channelId, {
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
    stateManager.setSessionCwd(guildId, channelId, resolvedPath);
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
  if (!model) return `${MODEL_OPTIONS[0].label} (default)`;
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
