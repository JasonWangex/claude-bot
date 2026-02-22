/**
 * .env 文件操作工具 (Discord 版)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger.js';

/**
 * 更新 .env 文件中的 AUTHORIZED_GUILD_ID
 */
export function updateAuthorizedGuildId(guildId: string): boolean {
  try {
    const envPath = resolve(process.cwd(), '.env');
    let envContent = readFileSync(envPath, 'utf-8');

    const currentMatch = envContent.match(/^AUTHORIZED_GUILD_ID=(.*)$/m);
    if (currentMatch && currentMatch[1].trim()) {
      logger.info('AUTHORIZED_GUILD_ID already set, cannot update');
      return false;
    }

    if (currentMatch) {
      envContent = envContent.replace(
        /^AUTHORIZED_GUILD_ID=.*$/m,
        `AUTHORIZED_GUILD_ID=${guildId}`
      );
    } else {
      if (!envContent.endsWith('\n')) {
        envContent += '\n';
      }
      envContent += `AUTHORIZED_GUILD_ID=${guildId}\n`;
    }

    writeFileSync(envPath, envContent, 'utf-8');
    process.env.AUTHORIZED_GUILD_ID = guildId;

    logger.info(`AUTHORIZED_GUILD_ID bound to: ${guildId}`);
    return true;
  } catch (error: any) {
    logger.error('Failed to update .env file:', error);
    return false;
  }
}

/**
 * 更新 .env 文件中的 GENERAL_CHANNEL_ID
 */
export function updateGeneralChannelId(channelId: string): boolean {
  try {
    const envPath = resolve(process.cwd(), '.env');
    let envContent = readFileSync(envPath, 'utf-8');

    const currentMatch = envContent.match(/^GENERAL_CHANNEL_ID=(.*)$/m);
    if (currentMatch) {
      envContent = envContent.replace(
        /^GENERAL_CHANNEL_ID=.*$/m,
        `GENERAL_CHANNEL_ID=${channelId}`
      );
    } else {
      if (!envContent.endsWith('\n')) {
        envContent += '\n';
      }
      envContent += `GENERAL_CHANNEL_ID=${channelId}\n`;
    }

    writeFileSync(envPath, envContent, 'utf-8');
    process.env.GENERAL_CHANNEL_ID = channelId;

    logger.info(`GENERAL_CHANNEL_ID set to: ${channelId}`);
    return true;
  } catch (error: any) {
    logger.error('Failed to update .env file:', error);
    return false;
  }
}

/**
 * 获取当前绑定的 Guild ID
 */
export function getAuthorizedGuildId(): string | undefined {
  return process.env.AUTHORIZED_GUILD_ID || undefined;
}

/**
 * 获取 General Channel ID
 */
export function getGeneralChannelId(): string | undefined {
  return process.env.GENERAL_CHANNEL_ID || undefined;
}

/**
 * 获取 Goal Log Channel ID（用于 pipeline 执行日志的独立输出）
 */
export function getGoalLogChannelId(): string | undefined {
  return process.env.GOAL_LOG_CHANNEL_ID || undefined;
}

/**
 * 获取 Bot Logs Channel ID（用于全局 Bot 日志输出）
 */
export function getBotLogsChannelId(): string | undefined {
  return process.env.BOT_LOGS_CHANNEL_ID || undefined;
}
