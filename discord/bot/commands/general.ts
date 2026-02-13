/**
 * General 命令: /login, /start, /help, /status
 * 可在 #general 或 task channel 中使用
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ChannelType,
} from 'discord.js';
import { timingSafeEqual } from 'crypto';
import { getAuthorizedGuildId, updateAuthorizedGuildId, updateGeneralChannelId } from '../../utils/env.js';
import { escapeMarkdown } from '../message-utils.js';
import { logger } from '../../utils/logger.js';
import type { CommandDeps } from './types.js';
import { requireAuth } from './utils.js';

export const generalCommands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('绑定 Bot 到此 Server')
    .addStringOption(opt =>
      opt.setName('token').setDescription('访问令牌').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('start')
    .setDescription('显示欢迎信息和使用说明'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('查看完整帮助'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('查看全局状态'),
];

export async function handleGeneralCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  switch (interaction.commandName) {
    case 'login':
      return handleLogin(interaction, deps);
    case 'start':
      return handleStart(interaction, deps);
    case 'help':
      return handleHelp(interaction, deps);
    case 'status':
      return handleStatus(interaction, deps);
  }
}

// ========== /login ==========

async function handleLogin(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
    return;
  }

  const token = interaction.options.getString('token', true);
  const accessToken = process.env.BOT_ACCESS_TOKEN || '';

  if (!accessToken) {
    await interaction.reply({ content: 'Server has no BOT_ACCESS_TOKEN configured.', ephemeral: true });
    return;
  }

  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(accessToken);
  if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
    await interaction.reply({ content: 'Invalid access token.', ephemeral: true });
    return;
  }

  const currentGuildId = getAuthorizedGuildId();

  if (!currentGuildId) {
    updateAuthorizedGuildId(guildId);

    // 自动记录 General Channel ID（如果在文字频道中执行）
    const channel = interaction.channel;
    if (channel && channel.type === ChannelType.GuildText) {
      updateGeneralChannelId(channel.id);
    }

    logger.info(`Auto-bound Guild ID ${guildId} to Bot`);
    await interaction.reply({
      content:
        '**Login successful!**\n\n' +
        `Bot is now bound to this server (ID: \`${guildId}\`).\n` +
        'Create task channels to start conversations with Claude.\n\n' +
        'Use `/start` for usage guide.',
      ephemeral: true,
    });
  } else if (currentGuildId === guildId) {
    await interaction.reply({
      content: `**Already authenticated.** Bot is bound to this server (ID: \`${guildId}\`).`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content:
        'This bot is already bound to another server.\n' +
        'Edit `.env` to clear `AUTHORIZED_GUILD_ID` to rebind.',
      ephemeral: true,
    });
  }
}

// ========== /start ==========

async function handleStart(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  const { stateManager } = deps;
  const guildId = interaction.guildId!;

  const channelId = interaction.channelId;
  const session = stateManager.getSession(guildId, channelId);

  if (session) {
    await interaction.reply(
      `**Claude Code is ready**\n\n` +
      `Working directory: \`${session.cwd}\`\n\n` +
      `Send messages to start a conversation.\n\n` +
      `Available commands:\n` +
      `- \`/cd\` - Change working directory\n` +
      `- \`/clear\` - Clear context\n` +
      `- \`/compact\` - Compact context\n` +
      `- \`/rewind\` - Undo last turn\n` +
      `- \`/plan\` - Plan mode\n` +
      `- \`/stop\` - Stop current task\n` +
      `- \`/model\` - Switch model\n` +
      `- \`/info\` - View details`
    );
  } else {
    const sessionCount = stateManager.getAllSessions(guildId).length;

    await interaction.reply(
      `**Welcome to Claude Code Discord Bot!**\n\n` +
      `Active channels: ${sessionCount}\n\n` +
      `**How to use:**\n` +
      `1. Use \`/task\` to create task channels\n` +
      `2. Send messages in task channels to chat with Claude\n` +
      `3. Different channels can work simultaneously\n\n` +
      `**General commands:**\n` +
      `- \`/task\` - Create task channel\n` +
      `- \`/status\` - View global status\n` +
      `- \`/model\` - Switch default model\n` +
      `- \`/help\` - Full help`
    );
  }
}

// ========== /help ==========

async function handleHelp(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;

  await interaction.reply(
    `**Claude Code Discord Bot Help**\n\n` +
    `**Task Management**\n` +
    `\`/task <name> [path] [category]\` - Create new task channel\n\n` +
    `**General Commands**\n` +
    `\`/login <token>\` - Bind Bot to this Server\n` +
    `\`/start\` - Show welcome info\n` +
    `\`/help\` - Show this help\n` +
    `\`/status\` - Global status overview\n` +
    `\`/model\` - Switch global default model\n\n` +
    `**Channel Commands** (inside task channels)\n` +
    `\`/cd [path]\` - Change working directory\n` +
    `\`/clear\` - Clear Claude context\n` +
    `\`/compact\` - Compact context\n` +
    `\`/rewind\` - Undo last turn\n` +
    `\`/plan <msg>\` - Plan mode (plan only, no execution)\n` +
    `\`/stop\` - Stop current task\n` +
    `\`/model\` - Switch current channel model\n` +
    `\`/info\` - View current channel details\n` +
    `\`/attach [session_id]\` - Link to Claude Session\n` +
    `\`/commit [note]\` - Review & commit code changes\n` +
    `\`/merge <branch>\` - Merge worktree branch to main\n` +
    `\`/close [--force]\` - Close channel & cleanup worktree/branch\n` +
    `\`/idea [desc]\` - Record an idea or develop existing one\n\n` +
    `**Usage:**\n` +
    `- Each task channel = independent session\n` +
    `- Send messages in task channels to chat with Claude\n` +
    `- Different channels can run tasks simultaneously\n` +
    `- Supports Fork (git worktree) for branch tasks`
  );
}

// ========== /status ==========

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;
  const { stateManager } = deps;
  const guildId = interaction.guildId!;

  const sessions = stateManager.getAllSessions(guildId);
  const defaultCwd = stateManager.getGuildDefaultCwd(guildId);

  const lines = sessions.map(s => {
    const claude = s.claudeSessionId ? '`linked`' : '`new`';
    const lastMsg = s.lastMessage
      ? `\n    ${s.lastMessage.slice(0, 60)}${s.lastMessage.length > 60 ? '...' : ''}`
      : '';
    return `${claude} **${escapeMarkdown(s.name)}** (${s.messageCount} msgs)${lastMsg}`;
  });

  const channelId = interaction.channelId;
  let currentInfo = '';
  const currentSession = stateManager.getSession(guildId, channelId);
  if (currentSession) {
    currentInfo = `\nCurrent channel: \`${escapeMarkdown(currentSession.name)}\`\n` +
      `Working directory: \`${escapeMarkdown(currentSession.cwd)}\`\n`;
  }

  await interaction.reply(
    `**Global Status**\n\n` +
    `Default working directory: \`${escapeMarkdown(defaultCwd)}\`\n` +
    `Active threads: ${sessions.length}\n` +
    currentInfo +
    (lines.length > 0 ? `\nAll sessions:\n\n${lines.join('\n\n')}` : '')
  );
}

