/**
 * Telegram Bot 初始化
 */

import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { StateManager } from './state.js';
import { CommandHandler } from './commands.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { TelegramBotConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class TelegramBot {
  private bot: Telegraf;
  private stateManager: StateManager;
  private commandHandler: CommandHandler;
  private messageHandler: MessageHandler;
  private claudeClient: ClaudeClient;

  constructor(config: TelegramBotConfig) {
    // 尝试多种代理配置
    const proxyUrl = process.env.https_proxy || process.env.http_proxy;
    const botOptions: any = {};

    if (proxyUrl) {
      logger.info('Configuring proxy for Telegraf:', proxyUrl);

      let agent;
      if (proxyUrl.startsWith('socks')) {
        agent = new SocksProxyAgent(proxyUrl);
        logger.info('Using SOCKS proxy agent');
      } else {
        agent = new HttpsProxyAgent(proxyUrl);
        logger.info('Using HTTPS proxy agent');
      }

      botOptions.telegram = { agent };
    }

    this.bot = new Telegraf(config.telegramToken, botOptions);

    // 初始化组件
    this.stateManager = new StateManager(config.defaultWorkDir);
    this.claudeClient = new ClaudeClient(
      config.claudeCliPath,
      config.commandTimeout,
      config.maxTurns
    );
    this.messageHandler = new MessageHandler(this.stateManager, this.claudeClient);
    this.commandHandler = new CommandHandler(this.stateManager, this.claudeClient, this.messageHandler);

    // 注册处理器
    this.registerHandlers();

    // 定期清理过期状态
    setInterval(() => {
      this.stateManager.cleanup();
    }, 60 * 60 * 1000);
  }

  private registerHandlers(): void {
    this.bot.command('login', (ctx) => this.commandHandler.handleLogin(ctx));
    this.bot.command('start', (ctx) => this.commandHandler.handleStart(ctx));
    this.bot.command('help', (ctx) => this.commandHandler.handleHelp(ctx));
    this.bot.command('status', (ctx) => this.commandHandler.handleStatus(ctx));
    this.bot.command('clear', (ctx) => this.commandHandler.handleClear(ctx));
    this.bot.command('cd', (ctx) => this.commandHandler.handleCd(ctx));
    this.bot.command('sessions', (ctx) => this.commandHandler.handleSessions(ctx));

    this.bot.on('text', async (ctx) => {
      try {
        await this.messageHandler.handleText(ctx);
      } catch (err) {
        logger.error('Text handler error:', err);
      }
    });

    this.bot.catch((err, ctx) => {
      logger.error('Bot error:', err);
      ctx.reply('❌ 内部错误，请稍后重试或使用 /clear 重置会话').catch(() => {});
    });
  }

  async verify(): Promise<boolean> {
    return this.claudeClient.verify();
  }

  async launch(): Promise<void> {
    const isAvailable = await this.verify();
    if (!isAvailable) {
      throw new Error(
        'Claude Code CLI 不可用。\n' +
        '请确保 Claude Code 已安装并可以在终端中执行 claude 命令。'
      );
    }

    logger.info('Claude Code CLI verified');

    // 从磁盘恢复用户会话状态
    await this.stateManager.load();

    logger.info('Starting long polling...');
    await this.bot.launch({ dropPendingUpdates: true });
    logger.info('Telegram Bot started');

    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  private async stop(signal: string): Promise<void> {
    logger.info(`Received ${signal}, stopping bot...`);
    await this.stateManager.flush();
    this.bot.stop(signal);
  }
}
