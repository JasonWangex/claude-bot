/**
 * Telegram Bot 初始化（Group + Forum Topics 模式）
 */

import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { StateManager } from './state.js';
import { CallbackRegistry } from './callback-registry.js';
import { CommandHandler, MODEL_OPTIONS } from './commands.js';
import { MessageHandler } from './handlers.js';
import { MessageQueue } from './message-queue.js';
import { ClaudeClient } from '../claude/client.js';
import { TelegramBotConfig } from '../types/index.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';
import { getAuthorizedChatId } from '../utils/env.js';
import { ApiServer } from '../api/server.js';

export class TelegramBot {
  private bot: Telegraf;
  private stateManager: StateManager;
  private callbackRegistry: CallbackRegistry;
  private commandHandler: CommandHandler;
  private messageHandler: MessageHandler;
  private messageQueue: MessageQueue;
  private claudeClient: ClaudeClient;
  private apiServer: ApiServer | null = null;
  private config: TelegramBotConfig;

  constructor(config: TelegramBotConfig) {
    this.config = config;
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
      config.maxTurns,
      config.stallTimeout
    );
    this.messageQueue = new MessageQueue(this.bot.telegram);
    this.messageHandler = new MessageHandler(this.stateManager, this.claudeClient, this.callbackRegistry, this.messageQueue);
    this.commandHandler = new CommandHandler(this.stateManager, this.claudeClient, this.messageHandler, this.messageQueue, this.config);
    this.messageHandler.setCommandHandler(this.commandHandler);

    // API 服务器（直接调用服务层，不走 Telegraf 管道）
    if (config.apiPort > 0) {
      this.apiServer = new ApiServer({
        stateManager: this.stateManager,
        claudeClient: this.claudeClient,
        messageHandler: this.messageHandler,
        telegram: this.bot.telegram,
        mq: this.messageQueue,
        config,
      });
    }

    // 注册处理器
    this.registerHandlers();

    // 定期清理过期状态
    setInterval(() => {
      this.stateManager.cleanup();
      this.callbackRegistry.cleanup();
    }, 60 * 60 * 1000);
  }

  private registerHandlers(): void {
    // 全局中间件：所有 ctx.reply / ctx.replyWithDocument 默认静默发送
    this.bot.use((ctx, next) => {
      const origReply = ctx.reply.bind(ctx);
      ctx.reply = (text: string, extra?: any) => {
        const opts = extra ?? {};
        if (opts.disable_notification === undefined) {
          opts.disable_notification = true;
        }
        return origReply(text, opts);
      };

      const origReplyDoc = ctx.replyWithDocument.bind(ctx);
      ctx.replyWithDocument = (doc: any, extra?: any) => {
        const opts = extra ?? {};
        if (opts.disable_notification === undefined) {
          opts.disable_notification = true;
        }
        return origReplyDoc(doc, opts);
      };

      return next();
    });

    // General 话题命令
    this.bot.command('login', (ctx) => this.commandHandler.handleLogin(ctx));
    this.bot.command('start', (ctx) => this.commandHandler.handleStart(ctx));
    this.bot.command('help', (ctx) => this.commandHandler.handleHelp(ctx));
    this.bot.command('status', (ctx) => this.commandHandler.handleStatus(ctx));

    // Topic 管理命令
    this.bot.command('topics', (ctx) => this.commandHandler.handleTopics(ctx));
    this.bot.command('newtopic', (ctx) => this.commandHandler.handleNewTopic(ctx));
    this.bot.command('listtopics', (ctx) => this.commandHandler.handleTopics(ctx));  // 兼容别名
    this.bot.command('topicinfo', (ctx) => this.commandHandler.handleTopicInfo(ctx));
    this.bot.command('renametopic', (ctx) => this.commandHandler.handleRenameTopic(ctx));
    this.bot.command('deletetopic', (ctx) => this.commandHandler.handleDeleteTopic(ctx));

    // Topic 内命令
    this.bot.command('cd', (ctx) => this.commandHandler.handleCd(ctx));
    this.bot.command('clear', (ctx) => this.commandHandler.handleClear(ctx));
    this.bot.command('compact', (ctx) => this.commandHandler.handleCompact(ctx));
    this.bot.command('rewind', (ctx) => this.commandHandler.handleRewind(ctx));
    this.bot.command('plan', (ctx) => this.commandHandler.handlePlan(ctx));
    this.bot.command('stop', (ctx) => this.commandHandler.handleStop(ctx));
    this.bot.command('info', (ctx) => this.commandHandler.handleInfo(ctx));
    this.bot.command('qdev', (ctx) => this.commandHandler.handleQdev(ctx));
    // General + Topic 通用命令
    this.bot.command('model', (ctx) => this.commandHandler.handleModel(ctx));

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

    // 模型切换回调: Topic 级别 model:<model_id>
    this.bot.action(/^model:(.+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) {
        ctx.answerCbQuery('❌ 未授权').catch(() => {});
        return;
      }
      const topicId = (ctx.callbackQuery?.message as any)?.message_thread_id as number | undefined;
      if (!topicId) {
        ctx.answerCbQuery('❌ 需要在 Topic 中操作').catch(() => {});
        return;
      }
      const groupId = ctx.chat.id;
      const selection = ctx.match[1];
      const model = selection === 'follow_default' ? undefined : selection;
      this.stateManager.setSessionModel(groupId, topicId, model);
      const label = model ? (MODEL_OPTIONS.find(m => m.id === model)?.label || model) : '跟随默认';
      ctx.answerCbQuery('✅ 已切换').catch(() => {});
      ctx.editMessageText(`✅ 模型已切换为: ${label}`).catch(() => {});
    });

    // 模型切换回调: Group 全局默认 gmodel:<model_id>
    this.bot.action(/^gmodel:(.+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) {
        ctx.answerCbQuery('❌ 未授权').catch(() => {});
        return;
      }
      const groupId = ctx.chat.id;
      const selection = ctx.match[1];
      const model = selection === 'default' ? undefined : selection;
      this.stateManager.setGroupDefaultModel(groupId, model);
      const label = model ? (MODEL_OPTIONS.find(m => m.id === model)?.label || model) : 'Sonnet 4.5 (默认)';
      ctx.answerCbQuery('✅ 已切换').catch(() => {});
      ctx.editMessageText(`✅ 全局默认模型已切换为: ${label}`).catch(() => {});
    });

    // Topic 管理回调
    this.bot.action(/^topic:info:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicInfoCallback(ctx).catch(e => logger.error('topic:info error:', e));
    });
    this.bot.action(/^topic:delete:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicDeleteCallback(ctx).catch(e => logger.error('topic:delete error:', e));
    });
    this.bot.action(/^topic:confirmdelete:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicConfirmDeleteCallback(ctx).catch(e => logger.error('topic:confirmdelete error:', e));
    });
    this.bot.action(/^topic:archive:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicArchiveCallback(ctx).catch(e => logger.error('topic:archive error:', e));
    });
    this.bot.action(/^topic:cancel$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicCancelCallback(ctx).catch(e => logger.error('topic:cancel error:', e));
    });

    // /topics 多层级按钮回调
    this.bot.action(/^topics:select:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsSelectCallback(ctx).catch(e => logger.error('topics:select error:', e));
    });
    this.bot.action(/^topics:back$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsBackCallback(ctx).catch(e => logger.error('topics:back error:', e));
    });
    this.bot.action(/^topics:refresh$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsRefreshCallback(ctx).catch(e => logger.error('topics:refresh error:', e));
    });
    this.bot.action(/^topics:create$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsCreateCallback(ctx).catch(e => logger.error('topics:create error:', e));
    });
    this.bot.action(/^topics:rename:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsRenameCallback(ctx).catch(e => logger.error('topics:rename error:', e));
    });
    this.bot.action(/^topics:fork:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsForkCallback(ctx).catch(e => logger.error('topics:fork error:', e));
    });
    this.bot.action(/^topics:merge:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsMergeCallback(ctx).catch(e => logger.error('topics:merge error:', e));
    });
    this.bot.action(/^topics:confirmmerge:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsConfirmMergeCallback(ctx).catch(e => logger.error('topics:confirmmerge error:', e));
    });
    this.bot.action(/^topics:delete:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsDeleteCallback(ctx).catch(e => logger.error('topics:delete error:', e));
    });
    this.bot.action(/^topics:confirmdelete:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsConfirmDeleteCallback(ctx).catch(e => logger.error('topics:confirmdelete error:', e));
    });
    this.bot.action(/^topics:confirmdeleteall:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsConfirmDeleteAllCallback(ctx).catch(e => logger.error('topics:confirmdeleteall error:', e));
    });
    this.bot.action(/^topics:archive:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsArchiveCallback(ctx).catch(e => logger.error('topics:archive error:', e));
    });
    this.bot.action(/^topics:backto:(\d+)$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsBackToCallback(ctx).catch(e => logger.error('topics:backto error:', e));
    });
    this.bot.action(/^topics:cancel$/, (ctx) => {
      if (!ctx.chat || !checkAuth(ctx)) { ctx.answerCbQuery('❌ 未授权').catch(() => {}); return; }
      this.commandHandler.handleTopicsCancelCallback(ctx).catch(e => logger.error('topics:cancel error:', e));
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

    // 监听 Forum Topic 事件：自动同步名称
    this.bot.on('forum_topic_created' as any, (ctx: any) => {
      if (!ctx.chat) return;
      const topicId = ctx.message?.message_thread_id;
      const topicData = ctx.message?.forum_topic_created;
      if (!topicId || !topicData) return;
      const session = this.stateManager.getSession(ctx.chat.id, topicId);
      if (!session) return;
      if (topicData.name && session.name !== topicData.name) {
        this.stateManager.setSessionName(ctx.chat.id, topicId, topicData.name);
        logger.info(`Topic name synced: ${session.name} → ${topicData.name}`);
      }
      // 同步 icon 信息（用户手动创建的 topic 可能带有自定义 icon）
      const newColor = topicData.icon_color;
      const newEmojiId = topicData.icon_custom_emoji_id || undefined;
      if (session.iconColor !== newColor || session.iconCustomEmojiId !== newEmojiId) {
        this.stateManager.setSessionIcon(ctx.chat.id, topicId, newColor, newEmojiId);
        logger.info(`Topic icon synced for ${topicId}: color=${newColor}, emoji=${newEmojiId}`);
      }
    });

    this.bot.on('forum_topic_edited' as any, (ctx: any) => {
      if (!ctx.chat) return;
      const topicId = ctx.message?.message_thread_id;
      const topicData = ctx.message?.forum_topic_edited;
      if (!topicId || !topicData) return;
      const session = this.stateManager.getSession(ctx.chat.id, topicId);
      if (!session) return;
      if (topicData.name && session.name !== topicData.name) {
        this.stateManager.setSessionName(ctx.chat.id, topicId, topicData.name);
        logger.info(`Topic name synced: ${session.name} → ${topicData.name}`);
      }
      // 同步 icon：icon_custom_emoji_id 存在时（含空字符串表示移除）更新
      if ('icon_custom_emoji_id' in topicData) {
        const newEmojiId = topicData.icon_custom_emoji_id || undefined;
        if (session.iconCustomEmojiId !== newEmojiId) {
          this.stateManager.setSessionIcon(ctx.chat.id, topicId, session.iconColor, newEmojiId);
          logger.info(`Topic icon synced: ${session.iconCustomEmojiId} → ${newEmojiId}`);
        }
      }
    });

    // 图片消息（fire-and-forget）
    this.bot.on('photo', (ctx) => {
      this.messageHandler.handlePhoto(ctx).catch((err) => {
        logger.error('Photo handler error:', err);
      });
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

    // 重连上次部署时正在运行的 Claude 进程
    await this.reconnectOrphanedProcesses();

    // 启动本地 API 服务器
    if (this.apiServer) {
      await this.apiServer.start();
    }

    // 启动消息队列消费者
    this.messageQueue.start();

    logger.info('Starting long polling...');
    await this.bot.launch({ dropPendingUpdates: true });
    logger.info('Telegram Bot started');

    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  private async reconnectOrphanedProcesses(): Promise<void> {
    await this.claudeClient.reconnectAll(async (info) => {
      const authorizedChatId = getAuthorizedChatId();
      if (!authorizedChatId) return;

      try {
        if (info.status === 'completed' && info.result) {
          // 更新 session 状态
          if (info.claudeSessionId) {
            this.stateManager.setSessionClaudeId(info.groupId, info.topicId, info.claudeSessionId);
          }
          // 发送结果到对应 topic
          await this.messageQueue.sendLong(authorizedChatId, info.topicId, info.result);

          // 发送完成标记
          const parts: string[] = ['重连恢复'];
          if (info.duration_ms) parts.push(`${(info.duration_ms / 1000).toFixed(1)}s`);
          if (info.usage) {
            const total = info.usage.input_tokens + info.usage.output_tokens;
            parts.push(`${Math.round(total / 1000)}K tokens`);
          }
          await this.messageQueue.send(authorizedChatId, info.topicId, `✅ 完成 (${parts.join(', ')})`, { silent: false, priority: 'high' });
        } else if (info.status === 'failed') {
          await this.bot.telegram.sendMessage(authorizedChatId, '⚠️ Bot 重启期间任务未能完成', {
            message_thread_id: info.topicId,
            disable_notification: false,
          });
        }
        // 'running' 状态由 monitorOrphanedProcess 继续处理
      } catch (err: any) {
        logger.error('Failed to send reconnected result:', err.message);
      }
    });
  }

  private async stop(signal: string): Promise<void> {
    logger.info(`Received ${signal}, stopping bot...`);
    // 停止消息队列定时 flush（但不丢弃已有操作）
    this.messageQueue.stop();
    // 排空已入队的消息和进行中的异步操作
    await this.messageQueue.drain(10000);
    // 关闭 API 服务器
    if (this.apiServer) {
      await this.apiServer.stop();
    }
    // 先 detach 所有正在运行的 Claude CLI 子进程，让它们继续独立运行
    this.claudeClient.detachAll();
    await this.stateManager.flush();
    this.bot.stop(signal);
  }
}
