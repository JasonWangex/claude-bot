/**
 * Discord Bot 配置管理
 */

import { DiscordBotConfig } from '../types/index.js';

export function loadDiscordConfig(): DiscordBotConfig {
  const discordToken = process.env.DISCORD_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const accessToken = process.env.BOT_ACCESS_TOKEN;

  if (!discordToken) {
    throw new Error(
      'DISCORD_TOKEN 环境变量未设置。\n' +
      '请在 .env 文件中设置 DISCORD_TOKEN=your-token-here'
    );
  }

  if (!applicationId) {
    throw new Error(
      'DISCORD_APPLICATION_ID 环境变量未设置。\n' +
      '请在 .env 文件中设置 DISCORD_APPLICATION_ID=your-app-id'
    );
  }

  if (!accessToken) {
    throw new Error(
      'BOT_ACCESS_TOKEN 环境变量未设置。\n' +
      '请在 .env 文件中设置 BOT_ACCESS_TOKEN=your-secret-token'
    );
  }

  const authorizedGuildId = process.env.AUTHORIZED_GUILD_ID || undefined;
  const generalChannelId = process.env.GENERAL_CHANNEL_ID || undefined;

  const defaultWorkDir = process.env.DEFAULT_WORK_DIR || process.env.HOME || '/tmp';
  const projectsRoot = process.env.PROJECTS_ROOT || defaultWorkDir;
  const autoCreateProjectDir = process.env.AUTO_CREATE_PROJECT_DIR !== 'false';
  const topicDirNaming = (process.env.TOPIC_DIR_NAMING || 'kebab-case') as 'kebab-case' | 'snake_case' | 'original';
  const worktreesDir = process.env.WORKTREES_DIR || `${projectsRoot}/worktrees`;
  const apiPort = parseInt(process.env.API_PORT || '3456', 10);

  return {
    discordToken,
    applicationId,
    accessToken,
    authorizedGuildId,
    generalChannelId,
    defaultWorkDir,
    claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude',
    maxTurns: parseInt(process.env.MAX_TURNS || '20', 10),
    commandTimeout: parseInt(process.env.COMMAND_TIMEOUT || '300000', 10),
    stallTimeout: parseInt(process.env.STALL_TIMEOUT || '60000', 10),
    projectsRoot,
    autoCreateProjectDir,
    topicDirNaming,
    worktreesDir,
    apiPort,
  };
}
