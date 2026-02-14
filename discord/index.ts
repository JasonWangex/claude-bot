/**
 * Discord Bot 入口
 */

import 'dotenv/config';
import { DiscordBot } from './bot/discord.js';
import { loadDiscordConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { initOss } from './utils/oss.js';
import { initDb, getDb, PromptConfigRepository } from './db/index.js';
import { PromptConfigService } from './services/prompt-config-service.js';
import { PROMPT_REQUIREMENTS } from './services/prompt-requirements.js';

async function main(): Promise<void> {
  logger.info('Starting Discord Bot...');
  initOss();
  const db = initDb();

  // 初始化 Prompt 配置服务
  const promptRepo = new PromptConfigRepository(db);
  const promptService = new PromptConfigService(promptRepo);
  await promptService.loadAll();

  // 启动校验：检查所有 prompt 是否存在 + 变量匹配
  const validation = promptService.validate(PROMPT_REQUIREMENTS);
  if (!validation.valid) {
    logger.error('[Startup] Prompt config validation failed:');
    for (const err of validation.errors) {
      logger.error(`  - ${err}`);
    }
    process.exit(1);
  }
  logger.info('[Startup] Prompt config validation passed');

  const config = loadDiscordConfig();
  const bot = new DiscordBot(config, promptService);

  try {
    await bot.launch();
  } catch (err: any) {
    logger.error('Failed to start bot:', err.message || err.code || err);
    process.exit(1);
  }
}

main();
