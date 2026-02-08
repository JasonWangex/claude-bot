/**
 * Telegram Bot 初始化（Group + Forum Topics 模式）
 */

import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { StateManager } from './state.js';
import { CallbackRegistry } from './callback-registry.js';
import { CommandHandler } from './commands.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { TelegramBotConfig } from '../types/index.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';

export class TelegramBot {
  private bot: Telegraf;
  private stateManager: StateManager;
  private callbackRegistry: CallbackRegistry;
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
    this.callbackRegistry = new CallbackRegistry();
    this.claudeClient = new ClaudeClient(
      config.claudeCliPath,
      config.commandTimeout,
      config.maxTurns
    );
    this.messageHandler = new MessageHandler(this.stateManager, this.claudeClient, this.callbackRegistry);
    this.commandHandler = new CommandHandler(this.stateManager, this.claudeClient, this.messageHandler);

    // 注册处理器
    this.registerHandlers();

    // 定期清理过期状态
    setInterval(() => {
      this.stateManager.cleanup();
      this.callbackRegistry.cleanup();
    }, 60 * 60 * 1000);
  }

  private registerHandlers(): void {
    // General 话题命令
    this.bot.command('login', (ctx) => this.commandHandler.handleLogin(ctx));
    this.bot.command('start', (ctx) => this.commandHandler.handleStart(ctx));
    this.bot.command('help', (ctx) => this.commandHandler.handleHelp(ctx));
    this.bot.command('status', (ctx) => this.commandHandler.handleStatus(ctx));
    this.bot.command('setcwd', (ctx) => this.commandHandler.handleSetCwd(ctx));

    // Topic 内命令
    this.bot.command('cd', (ctx) => this.commandHandler.handleCd(ctx));
    this.bot.command('clear', (ctx) => this.commandHandler.handleClear(ctx));
    this.bot.command('compact', (ctx) => this.commandHandler.handleCompact(ctx));
    this.bot.command('rewind', (ctx) => this.commandHandler.handleRewind(ctx));
    this.bot.command('plan', (ctx) => this.commandHandler.handlePlan(ctx));
    this.bot.command('stop', (ctx) => this.commandHandler.handleStop(ctx));
    this.bot.command('info', (ctx) => this.commandHandler.handleInfo(ctx));

    // 交互式输入回调: 处理 Inline Keyboard 点击
    this.bot.action(/^input:(.+):(.+)$/, (ctx) => {
      const match = ctx.match;
      const truncatedId = match[1];
      const selection = match[2];

      const entry = this.callbackRegistry.findByTruncatedId(truncatedId);
      if (!entry) {
        ctx.answerCbQuery('❌ 此按钮已过期').catch(() => {});
        return;
      }

      const toolUseId = entry.toolUseId;

      if (selection === 'other') {
        // 标记等待自定义文本输入
        this.callbackRegistry.setWaitingCustomText(toolUseId, true);
        ctx.answerCbQuery().catch(() => {});
        ctx.editMessageText(
          '✏️ 请直接输入你的回复:',
        ).catch(() => {});
        return;
      }

      if (selection === 'approve') {
        this.callbackRegistry.resolve(toolUseId, 'approve');
        ctx.answerCbQuery('✅ 已批准').catch(() => {});
        ctx.editMessageText('✅ 已批准执行方案').catch(() => {});
        return;
      }

      if (selection === 'compact_execute') {
        this.callbackRegistry.resolve(toolUseId, 'compact_execute');
        ctx.answerCbQuery('🗜️ 压缩并执行').catch(() => {});
        ctx.editMessageText('🗜️ 压缩上下文后执行方案...').catch(() => {});
        return;
      }

      if (selection === 'reject') {
        this.callbackRegistry.resolve(toolUseId, 'reject');
        ctx.answerCbQuery('❌ 已拒绝').catch(() => {});
        ctx.editMessageText('❌ 已拒绝方案').catch(() => {});
        return;
      }

      // 数字索引 → 查找选项标签
      const index = parseInt(selection, 10);
      if (!isNaN(index)) {
        const label = this.callbackRegistry.getOptionLabel(toolUseId, index);
        const answer = label || `option_${index}`;
        this.callbackRegistry.resolve(toolUseId, answer);
        ctx.answerCbQuery(`✅ ${answer}`).catch(() => {});
        ctx.editMessageText(`✅ 已选择: ${answer}`).catch(() => {});
        return;
      }

      ctx.answerCbQuery('❌ 无效选择').catch(() => {});
    });

    // 停止按钮回调: stop:<lockKey-prefix>
    this.bot.action(/^stop:(.+)$/, (ctx) => {
      if (!ctx.chat) return;
      if (!checkAuth(ctx)) {
        ctx.answerCbQuery('❌ 未授权').catch(() => {});
        return;
      }
      // 从 callback data 中取 lockKey 前缀，尝试 abort
      const lockKeyPrefix = ctx.match[1];
      const wasRunning = this.claudeClient.abort(lockKeyPrefix);
      ctx.answerCbQuery(wasRunning ? '⏹ 正在停止...' : 'ℹ️ 没有运行中的任务').catch(() => {});
    });

    // fire-and-forget: 长时间 Claude 任务不阻塞 Telegraf 中间件链
    this.bot.on('text', (ctx) => {
      this.messageHandler.handleText(ctx).catch((err) => {
        logger.error('Text handler error:', err);
      });
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

    // 从磁盘恢复会话状态
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
