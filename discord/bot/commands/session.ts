/**
 * Session 命令: /clear, /compact, /rewind, /plan, /stop, /attach
 * 这些命令只在 task channel 中有效
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { escapeMarkdown } from '../message-utils.js';
import { StateManager } from '../state.js';
import { logger } from '../../utils/logger.js';
import type { CommandDeps } from './types.js';
import { requireAuth, requireThread } from './utils.js';

export const sessionCommands = [
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear Claude conversation context'),

  new SlashCommandBuilder()
    .setName('compact')
    .setDescription('Compact Claude conversation context'),

  new SlashCommandBuilder()
    .setName('rewind')
    .setDescription('Undo last conversation turn'),

  new SlashCommandBuilder()
    .setName('plan')
    .setDescription('Send message in plan mode (plan only, no execution)')
    .addStringOption(opt =>
      opt.setName('message').setDescription('Message to send in plan mode').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the currently running Claude task')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Follow-up message to send after stopping (interrupt & resume)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('attach')
    .setDescription('Link to a specific Claude session')
    .addStringOption(opt =>
      opt.setName('session_id').setDescription('Claude session ID to attach to').setRequired(false)
    ),
];

export async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'clear':
      return handleClear(interaction, deps);
    case 'compact':
      return handleCompact(interaction, deps);
    case 'rewind':
      return handleRewind(interaction, deps);
    case 'plan':
      return handlePlan(interaction, deps);
    case 'stop':
      return handleStop(interaction, deps);
    case 'attach':
      return handleAttach(interaction, deps);
  }
}

// ========== /clear ==========

async function handleClear(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  deps.stateManager.clearSessionClaudeId(guildId, channelId);
  await interaction.reply('Context cleared. Next message will start a new Claude session.');
}

// ========== /compact ==========

async function handleCompact(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const { stateManager, claudeClient } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session?.claudeSessionId) {
    await interaction.reply({ content: 'No active Claude context to compact.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  let preTokens: number | null = null;
  let postTokens: number | null = null;

  const onProgress = (event: any) => {
    if (event.compact_metadata) {
      preTokens = event.compact_metadata.pre_tokens;
    }
    if (event.usage) {
      postTokens = event.usage.input_tokens
        + (event.usage.cache_read_input_tokens || 0)
        + (event.usage.cache_creation_input_tokens || 0);
    }
  };

  try {
    const lockKey = StateManager.channelLockKey(guildId, channelId);
    await claudeClient.compact(session.claudeSessionId, session.cwd, lockKey, onProgress);

    let info = 'Context compacted';
    if (preTokens) {
      info += `\nBefore: ${Math.round(preTokens / 1000)}K tokens`;
      if (postTokens) {
        info += ` → After: ${Math.round(postTokens / 1000)}K tokens`;
      }
    }
    await interaction.editReply(info);
  } catch (error: any) {
    await interaction.editReply(`Compact failed: ${error.message}`);
  }
}

// ========== /rewind ==========

async function handleRewind(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;

  const result = deps.stateManager.rewindSession(guildId, channelId);
  if (!result.success) {
    await interaction.reply({ content: result.reason || 'Cannot rewind', ephemeral: true });
    return;
  }

  await interaction.reply('Last conversation turn undone. Claude context will continue from previous turn.');
}

// ========== /plan ==========

async function handlePlan(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const message = interaction.options.getString('message', true);

  deps.stateManager.setSessionPlanMode(guildId, channelId, true);

  // TODO: Phase 5 — 将消息路由到 messageHandler.handleTextWithMode()
  await interaction.reply(`Plan mode enabled. Processing: ${message.slice(0, 100)}...`);
}

// ========== /stop ==========

async function handleStop(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const { stateManager, claudeClient, messageHandler } = deps;

  const session = stateManager.getSession(guildId, channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found.', ephemeral: true });
    return;
  }

  const lockKey = StateManager.channelLockKey(guildId, channelId);
  const followUpMessage = interaction.options.getString('message');

  if (followUpMessage) {
    // 有 follow-up message: 只杀进程，不排空队列，然后发送新消息
    const result = claudeClient.abortRunning(lockKey);
    if (!result.aborted) {
      await interaction.reply({ content: 'No running task to interrupt.', ephemeral: true });
      return;
    }
    await interaction.reply(`Interrupting and sending: ${followUpMessage.slice(0, 100)}...`);
    // 新消息通过正常流程发送，会自动 acquireLock 等待进程退出后执行
    messageHandler.sendChatByIds(guildId, channelId, followUpMessage).catch(err => {
      logger.error(`[/stop follow-up] error:`, err.message);
    });
  } else {
    // 无 message: 原有行为，全停
    const wasRunning = claudeClient.abort(lockKey);
    await interaction.reply(wasRunning
      ? 'Stopping task...'
      : 'No running task to stop.');
  }
}

// ========== /attach ==========

async function handleAttach(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  if (!requireThread(interaction)) return;

  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const { stateManager, claudeClient } = deps;
  const threadName = (interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null) ?? `thread-${channelId}`;

  const session = stateManager.getOrCreateSession(guildId, channelId, {
    name: threadName,
    cwd: stateManager.getGuildDefaultCwd(guildId),
  });

  const targetSessionId = interaction.options.getString('session_id');

  if (!targetSessionId) {
    const currentId = session.claudeSessionId;
    await interaction.reply({
      content: currentId
        ? `Current Claude Session: \`${currentId}\`\n\nUsage: \`/attach session_id:<id>\``
        : `No active Claude Session.\n\nUsage: \`/attach session_id:<id>\``,
      ephemeral: true,
    });
    return;
  }

  // 检查是否有其他 thread 持有该 session
  const holder = stateManager.findSessionHolder(guildId, targetSessionId);
  if (holder && holder.channelId === channelId) {
    await interaction.reply({ content: 'Already linked to this session.', ephemeral: true });
    return;
  }

  if (holder) {
    const holderLockKey = StateManager.channelLockKey(guildId, holder.channelId);
    if (claudeClient.isRunning(holderLockKey)) {
      await interaction.reply({
        content: `Thread "${holder.name}" is currently using this session. Stop it first.`,
        ephemeral: true,
      });
      return;
    }
    stateManager.clearSessionClaudeId(guildId, holder.channelId);
  }

  const currentLockKey = StateManager.channelLockKey(guildId, channelId);
  if (claudeClient.isRunning(currentLockKey)) {
    await interaction.reply({
      content: 'Current thread has a running task. Stop it first.',
      ephemeral: true,
    });
    return;
  }

  stateManager.setSessionClaudeId(guildId, channelId, targetSessionId);

  let msg = `Linked to Claude Session: \`${targetSessionId.slice(0, 8)}...\``;
  if (holder) {
    msg += `\n(Disconnected from thread "${holder.name}")`;
  }
  await interaction.reply(msg);
}

