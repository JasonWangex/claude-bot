/**
 * .env 文件操作工具
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger.js';

/**
 * 更新 .env 文件中的 AUTHORIZED_CHAT_ID
 */
export function updateAuthorizedChatId(chatId: number): boolean {
  try {
    const envPath = resolve(process.cwd(), '.env');
    let envContent = readFileSync(envPath, 'utf-8');

    // 检查是否已经设置了 AUTHORIZED_CHAT_ID（非空）
    const currentMatch = envContent.match(/^AUTHORIZED_CHAT_ID=(.*)$/m);
    if (currentMatch && currentMatch[1].trim()) {
      logger.info('AUTHORIZED_CHAT_ID already set, cannot update');
      return false;
    }

    // 更新或添加 AUTHORIZED_CHAT_ID
    if (currentMatch) {
      // 已存在但为空，更新值
      envContent = envContent.replace(
        /^AUTHORIZED_CHAT_ID=.*$/m,
        `AUTHORIZED_CHAT_ID=${chatId}`
      );
    } else {
      // 不存在，添加到文件末尾
      if (!envContent.endsWith('\n')) {
        envContent += '\n';
      }
      envContent += `AUTHORIZED_CHAT_ID=${chatId}\n`;
    }

    // 写回文件
    writeFileSync(envPath, envContent, 'utf-8');

    // 更新 process.env
    process.env.AUTHORIZED_CHAT_ID = String(chatId);

    logger.info(`AUTHORIZED_CHAT_ID bound to: ${chatId}`);
    return true;
  } catch (error: any) {
    logger.error('Failed to update .env file:', error.message);
    return false;
  }
}

/**
 * 获取当前绑定的 Chat ID
 */
export function getAuthorizedChatId(): number | undefined {
  const chatId = process.env.AUTHORIZED_CHAT_ID;
  if (!chatId) return undefined;
  const parsed = parseInt(chatId, 10);
  return isNaN(parsed) ? undefined : parsed;
}
