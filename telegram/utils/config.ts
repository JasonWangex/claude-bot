/**
 * Telegram Bot 配置管理
 */

import { TelegramBotConfig } from '../types/index.js';

export function loadTelegramConfig(): TelegramBotConfig {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const accessToken = process.env.BOT_ACCESS_TOKEN;

  if (!telegramToken) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN 环境变量未设置。\n' +
      '请在 .env 文件中设置 TELEGRAM_BOT_TOKEN=your-token-here'
    );
  }

  if (!accessToken) {
    throw new Error(
      'BOT_ACCESS_TOKEN 环境变量未设置。\n' +
      '请在 .env 文件中设置 BOT_ACCESS_TOKEN=your-secret-token'
    );
  }

  const authorizedChatId = process.env.AUTHORIZED_CHAT_ID
    ? parseInt(process.env.AUTHORIZED_CHAT_ID, 10)
    : undefined;

  const defaultWorkDir = process.env.DEFAULT_WORK_DIR || process.env.HOME || '/tmp';
  const projectsRoot = process.env.PROJECTS_ROOT || defaultWorkDir;
  const autoCreateProjectDir = process.env.AUTO_CREATE_PROJECT_DIR !== 'false'; // 默认 true
  const topicDirNaming = (process.env.TOPIC_DIR_NAMING || 'kebab-case') as 'kebab-case' | 'snake_case' | 'original';
  const worktreesDir = process.env.WORKTREES_DIR || `${projectsRoot}/worktrees`;
  const apiPort = parseInt(process.env.API_PORT || '3456', 10);

  return {
    telegramToken,
    accessToken,
    authorizedChatId,
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
