/**
 * Discord Bot 入口
 */

import 'dotenv/config';
import { DiscordBot } from './bot/discord.js';
import { loadDiscordConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { initOss } from './utils/oss.js';
import { initDb } from './db/index.js';

async function main(): Promise<void> {
  logger.info('Starting Discord Bot...');
  initOss();
  initDb();

  const config = loadDiscordConfig();
  const bot = new DiscordBot(config);

  try {
    await bot.launch();
  } catch (err: any) {
    logger.error('Failed to start bot:', err.message || err.code || err);
    process.exit(1);
  }
}

main();
