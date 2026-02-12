/**
 * Telegram Claude Bot 入口
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { watch } from 'chokidar';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { TelegramBot } from './bot/telegram.js';
import { loadTelegramConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { initOss } from './utils/oss.js';
import { resolve } from 'path';

// 检查是否配置了 Telegram Bot Token
if (!process.env.TELEGRAM_BOT_TOKEN) {
  logger.info('TELEGRAM_BOT_TOKEN not set, Telegram bot disabled');
  process.exit(0);
}

// 配置全局代理（undici - 仅支持 HTTP/HTTPS 代理）
const proxyUrl = process.env.https_proxy || process.env.http_proxy;
if (proxyUrl && (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://'))) {
  const proxyAgent = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(proxyAgent);
  logger.info('Global HTTP proxy configured:', proxyUrl);
} else if (proxyUrl) {
  logger.info('SOCKS proxy detected, will be configured in Telegraf:', proxyUrl);
}

// 全局异常兜底：防止未捕获异常导致进程静默崩溃
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

let exiting = false;
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  if (exiting) return;
  exiting = true;
  // 致命错误，给日志系统时间 flush，然后退出让进程管理器重启
  setTimeout(() => process.exit(1), 1000);
});

async function main() {
  try {
    // 加载配置
    const config = loadTelegramConfig();
    initOss();

    logger.info('Starting Telegram Bot...');
    logger.info('Bot Token (first 10 chars):', config.telegramToken.substring(0, 10) + '...');

    // 监听 .env 文件变化并热重载
    const envPath = resolve(process.cwd(), '.env');
    const watcher = watch(envPath, {
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', () => {
      logger.info('.env file changed, reloading configuration...');
      dotenvConfig({ override: true });
      logger.info('Configuration reloaded');
      logger.info('Authorized Chat ID:', process.env.AUTHORIZED_CHAT_ID || '(not set)');
    });

    logger.info('Watching .env file for changes:', envPath);

    // 创建并启动 Bot
    const bot = new TelegramBot(config);
    await bot.launch();

  } catch (error: any) {
    logger.error('Failed to start bot:', error.message);
    if (error.stack) {
      logger.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

main();
