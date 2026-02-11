/**
 * Telegram Bot 命令处理器（Group + Forum Topics 模式）
 */

import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { StateManager } from './state.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { escapeHtml } from './message-utils.js';
import { MessageQueue } from './message-queue.js';
import { StreamEvent, TelegramBotConfig } from '../types/index.js';
import { spawn, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { stat, readFile } from 'fs/promises';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { timingSafeEqual } from 'crypto';
import { updateAuthorizedChatId, getAuthorizedChatId } from '../utils/env.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';
import {
  normalizeTopicName,
  resolveTopicWorkDir,
  ensureProjectDir,
  resolveCustomPath
} from '../utils/topic-path.js';

export const MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

// General 话题中等待文本输入的状态
interface PendingTextInput {
  type: 'create';
  chatId: number;
  messageId: number;  // 提示消息 ID，完成后编辑
}

export class CommandHandler {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;
  private messageHandler: MessageHandler;
  private mq: MessageQueue;
  private config: TelegramBotConfig;

  // General 话题文本收集状态 (groupId → PendingTextInput)
  private pendingTextInput: Map<number, PendingTextInput> = new Map();

  constructor(stateManager: StateManager, claudeClient: ClaudeClient, messageHandler: MessageHandler, mq: MessageQueue, config: TelegramBotConfig) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
    this.messageHandler = messageHandler;
    this.mq = mq;
    this.config = config;
  }

  private getAccessToken(): string {
    return process.env.BOT_ACCESS_TOKEN || '';
  }

  /**
   * 获取 topicId，返回 undefined 表示在 General topic
   */
  private getTopicId(ctx: Context): number | undefined {
    return (ctx.message as any)?.message_thread_id as number | undefined;
  }

  /**
   * 要求鉴权（通用）
   */
  private async requireAuth(ctx: Context, handler: () => Promise<void>): Promise<void> {
    if (!ctx.chat || !checkAuth(ctx)) {
      const authorizedChatId = getAuthorizedChatId();
      await ctx.reply(
        '❌ 未授权访问\n\n' +
        (authorizedChatId
          ? '此 Bot 仅限已授权的 Group 使用。'
          : '请先在 General 话题中使用 /login <token> 进行鉴权。')
      );
      return;
    }
    await handler();
  }

  /**
   * 要求在 Topic 内执行（非 General），并获取 session
   */
  private async requireTopic(ctx: Context, handler: (session: any, topicId: number) => Promise<void>): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const topicId = this.getTopicId(ctx);
      if (!topicId) {
        await ctx.reply('❌ 此命令需要在 Topic 中使用，不能在 General 话题中执行。');
        return;
      }
      const groupId = ctx.chat!.id;

      // 尝试从消息上下文获取 Topic 真实名称
      const replyMsg = (ctx.message as any)?.reply_to_message;
      const topicCreated = replyMsg?.forum_topic_created;
      const topicName = topicCreated?.name || `topic-${topicId}`;

      const session = this.stateManager.getOrCreateSession(groupId, topicId, {
        name: topicName,
        cwd: this.stateManager.getGroupDefaultCwd(groupId),
      });

      // 如果名称是默认值且拿到了真实名称，同步
      if (topicCreated?.name && session.name !== topicCreated.name && session.name.startsWith('topic-')) {
        this.stateManager.setSessionName(groupId, topicId, topicCreated.name);
        session.name = topicCreated.name;
      }

      // 同步 icon 信息（从 reply_to_message 的 forum_topic_created 中获取）
      if (topicCreated && session.iconColor == null && session.iconCustomEmojiId == null) {
        const iconColor = topicCreated.icon_color;
        const iconEmojiId = topicCreated.icon_custom_emoji_id || undefined;
        if (iconColor != null || iconEmojiId != null) {
          this.stateManager.setSessionIcon(groupId, topicId, iconColor, iconEmojiId);
        }
      }

      await handler(session, topicId);
    });
  }

  // ========== General Topic 命令 ==========

  async handleLogin(ctx: Context): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    const text = (ctx.message as any)?.text || '';
    const args = text.split(/\s+/).slice(1);

    if (args.length === 0) {
      await ctx.reply('请提供访问令牌: /login <token>');
      return;
    }

    const token = args[0];
    const accessToken = this.getAccessToken();

    if (!accessToken) {
      await ctx.reply('❌ 服务端未配置 BOT_ACCESS_TOKEN。');
      return;
    }

    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(accessToken);
    if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
      await ctx.reply('❌ 访问令牌无效。');
      return;
    }

    const currentChatId = getAuthorizedChatId();

    if (!currentChatId) {
      const success = updateAuthorizedChatId(chatId);
      if (success) {
        logger.info(`Auto-bound Group ID ${chatId} to Bot`);
        await ctx.reply(
          '✅ 鉴权成功！\n\n' +
          `Bot 已绑定到此 Group（ID: ${chatId}）。\n` +
          '在各 Topic 中直接发消息即可与 Claude 对话。\n\n' +
          '使用 /setcwd <path> 设置默认工作目录。'
        );
      } else {
        await ctx.reply('✅ 鉴权成功！现在可以使用 Bot 了。');
      }
    } else if (currentChatId === chatId) {
      await ctx.reply(
        '✅ 鉴权成功！\n\n' +
        `Bot 已绑定到此 Group（ID: ${chatId}）。`
      );
    } else {
      await ctx.reply(
        '❌ 此 Bot 已绑定到其他 Group。\n\n' +
        '如需更改绑定，请编辑 .env 文件清除 AUTHORIZED_CHAT_ID。'
      );
    }
  }

  async handleStart(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const topicId = this.getTopicId(ctx);
      if (topicId) {
        // Topic 内
        const groupId = ctx.chat!.id;

        // 尝试从消息上下文获取 Topic 真实名称
        const replyMsg = (ctx.message as any)?.reply_to_message;
        const topicCreated = replyMsg?.forum_topic_created;
        const topicName = topicCreated?.name || `topic-${topicId}`;

        const session = this.stateManager.getOrCreateSession(groupId, topicId, {
          name: topicName,
          cwd: this.stateManager.getGroupDefaultCwd(groupId),
        });

        // 同步名称
        if (topicCreated?.name && session.name !== topicCreated.name && session.name.startsWith('topic-')) {
          this.stateManager.setSessionName(groupId, topicId, topicCreated.name);
          session.name = topicCreated.name;
        }

        // 同步 icon 信息
        if (topicCreated && session.iconColor == null && session.iconCustomEmojiId == null) {
          const iconColor = topicCreated.icon_color;
          const iconEmojiId = topicCreated.icon_custom_emoji_id || undefined;
          if (iconColor != null || iconEmojiId != null) {
            this.stateManager.setSessionIcon(groupId, topicId, iconColor, iconEmojiId);
          }
        }

        await ctx.reply(
          `👋 Claude Code 已就绪\n\n` +
          `工作目录: ${session.cwd}\n\n` +
          `直接发送消息即可开始对话。\n\n` +
          `可用命令:\n` +
          `• /cd - 切换工作目录\n` +
          `• /clear - 清空上下文\n` +
          `• /compact - 压缩上下文\n` +
          `• /rewind - 撤销上一轮\n` +
          `• /plan - 规划模式\n` +
          `• /stop - 停止任务\n` +
          `• /model - 切换模型\n` +
          `• /info - 查看详情`
        );
      } else {
        // General topic
        const defaultCwd = this.stateManager.getGroupDefaultCwd(ctx.chat!.id);
        const sessionCount = this.stateManager.getAllSessions(ctx.chat!.id).length;
        await ctx.reply(
          `👋 欢迎使用 Claude Code Telegram Bot！\n\n` +
          `活跃 Topic 数: ${sessionCount}\n\n` +
          `使用方法:\n` +
          `1. 使用 /topics 管理 Topic（创建/查看/Fork/重命名/归档/删除）\n` +
          `2. 在 Topic 中直接发消息与 Claude 对话\n` +
          `3. 不同 Topic 可以同时工作，互不干扰\n\n` +
          `General 命令:\n` +
          `• /topics - 管理 Topic（多层级按钮）\n` +
          `• /newtopic - 快速创建 Topic\n` +
          `• /status - 查看全局状态\n` +
          `• /model - 切换全局默认模型\n` +
          `• /help - 查看完整帮助`
        );
      }
    });
  }

  async handleHelp(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      await ctx.reply(
        `🤖 Claude Code Telegram Bot 帮助\n\n` +
        `<b>Topic 管理（General 话题）</b>\n` +
        `/topics - 管理 Topic（多层级按钮：创建/查看/Fork/重命名/归档/删除）\n` +
        `/newtopic &lt;名称&gt; [路径] - 快速创建新 Topic\n\n` +
        `<b>General 命令</b>\n` +
        `/login &lt;token&gt; - 绑定 Bot 到此 Group\n` +
        `/start - 显示欢迎信息\n` +
        `/help - 显示此帮助\n` +
        `/status - 全局状态概览\n` +
        `/model - 切换全局默认模型\n\n` +
        `<b>Topic 内命令</b>\n` +
        `/cd [path] - 切换工作目录\n` +
        `/clear - 清空 Claude 上下文\n` +
        `/compact - 压缩上下文\n` +
        `/rewind - 撤销最后一轮对话\n` +
        `/plan &lt;msg&gt; - Plan 模式（只规划不执行）\n` +
        `/stop - 停止当前任务\n` +
        `/model - 切换当前 Topic 模型\n` +
        `/info - 查看当前 Topic 详情\n` +
        `/attach [session_id] - 链接到指定 Claude Session\n` +
        `/commit [备注] - 审查代码变更后自动提交\n` +
        `/merge &lt;topic或分支名&gt; - 合并 worktree 分支到 main 并清理\n\n` +
        `<b>使用方法</b>\n` +
        `• /topics 统一管理所有 Topic（每个 Topic = 独立会话）\n` +
        `• 在 Topic 中直接发消息即可对话\n` +
        `• 不同 Topic 可以同时执行任务，互不干扰\n` +
        `• 支持 Fork（git worktree）创建分支 Topic`,
        { parse_mode: 'HTML' }
      );
    });
  }

  async handleStatus(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const sessions = this.stateManager.getAllSessions(groupId);
      const defaultCwd = this.stateManager.getGroupDefaultCwd(groupId);

      const lines = sessions.map(s => {
        const claude = s.claudeSessionId ? '🔗' : '🆕';
        const lastMsg = s.lastMessage
          ? `\n    ${s.lastMessage.slice(0, 60)}${s.lastMessage.length > 60 ? '...' : ''}`
          : '';
        return `${claude} <b>${escapeHtml(s.name)}</b> (${s.messageHistory.length} 条)${lastMsg}`;
      });

      const topicId = this.getTopicId(ctx);
      let currentInfo = '';
      if (topicId) {
        const session = this.stateManager.getSession(groupId, topicId);
        if (session) {
          currentInfo = `\n当前 Topic 会话: <code>${escapeHtml(session.name)}</code>\n` +
            `工作目录: <code>${escapeHtml(session.cwd)}</code>\n`;
        }
      }

      await ctx.reply(
        `📊 全局状态\n\n` +
        `默认工作目录: <code>${escapeHtml(defaultCwd)}</code>\n` +
        `活跃 Topic 数: ${sessions.length}\n` +
        currentInfo +
        (lines.length > 0 ? `\n所有会话:\n\n${lines.join('\n\n')}` : ''),
        { parse_mode: 'HTML' }
      );
    });
  }


  // ========== Topic 内命令 ==========

  async handleClear(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      this.stateManager.clearSessionClaudeId(ctx.chat!.id, topicId);
      await ctx.reply(`✅ 对话历史已清空，下次对话将开启新的 Claude 会话。`);
    });
  }

  async handleCompact(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const chatId = ctx.chat!.id;

      if (!session.claudeSessionId) {
        await ctx.reply('❌ 当前没有活跃的 Claude 上下文，无需压缩。');
        return;
      }

      const progressMsg = await ctx.reply(`🗜️ 正在压缩上下文...`);

      let preTokens: number | null = null;
      let postTokens: number | null = null;

      const onProgress = (event: StreamEvent) => {
        if (event.compact_metadata) {
          preTokens = event.compact_metadata.pre_tokens;
        }
        if (event.usage) {
          postTokens = event.usage.input_tokens
            + (event.usage.cache_read_input_tokens || 0)
            + (event.usage.cache_creation_input_tokens || 0);
        }
      };

      try {
        const lockKey = StateManager.topicLockKey(chatId, topicId);
        await this.claudeClient.compact(session.claudeSessionId, session.cwd, lockKey, onProgress);

        let info = `✅ 上下文已压缩`;
        if (preTokens) {
          info += `\n压缩前: ${Math.round(preTokens / 1000)}K tokens`;
          if (postTokens) {
            info += ` → 压缩后: ${Math.round(postTokens / 1000)}K tokens`;
          }
        }

        await ctx.telegram.editMessageText(chatId, progressMsg.message_id, undefined, info);
      } catch (error: any) {
        await ctx.telegram.editMessageText(
          chatId, progressMsg.message_id, undefined,
          `❌ 压缩失败: ${error.message}`
        ).catch(() => {});
      }
    });
  }

  async handleRewind(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const result = this.stateManager.rewindSession(ctx.chat!.id, topicId);
      if (!result.success) {
        await ctx.reply(`❌ ${result.reason}`);
        return;
      }

      await ctx.reply(
        `✅ 已撤销最后一轮对话\n` +
        `本地记录已回退，Claude 上下文将从上一轮继续。`
      );
    });
  }

  async handlePlan(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const text = (ctx.message as any)?.text || '';
      const message = text.replace(/^\/plan\s*/, '').trim();

      if (!message) {
        await ctx.reply(
          '用法: /plan <message>\n\n' +
          '以 Plan 模式发送消息，Claude 只会输出方案而不执行。\n' +
          '方案输出后，回复 "ok" 或 "确认" 将自动压缩上下文并执行实现。'
        );
        return;
      }

      this.stateManager.setSessionPlanMode(ctx.chat!.id, topicId, true);
      await this.messageHandler.handleTextWithMode(ctx, 'plan');
    });
  }

  async handleCd(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);

      if (args.length === 0) {
        await ctx.reply(`当前工作目录: <code>${escapeHtml(session.cwd)}</code>`, { parse_mode: 'HTML' });
        return;
      }

      const input = args[0];
      const resolvedPath = resolve(session.cwd, input);

      try {
        const s = await stat(resolvedPath);
        if (!s.isDirectory()) {
          await ctx.reply(`❌ 不是目录: ${resolvedPath}`);
          return;
        }
        this.stateManager.setSessionCwd(ctx.chat!.id, topicId, resolvedPath);
        await ctx.reply(`✅ 工作目录已切换到: <code>${escapeHtml(resolvedPath)}</code>`, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(`❌ 目录不存在: ${resolvedPath}`);
      }
    });
  }

  async handleStop(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session) => {
      const lockKey = StateManager.topicLockKey(session.groupId, session.topicId);
      const wasRunning = this.claudeClient.abort(lockKey);
      await ctx.reply(wasRunning
        ? `⏹ 正在停止任务...`
        : `ℹ️ 当前没有正在执行的任务`);
    });
  }

  async handleInfo(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session) => {
      const created = new Date(session.createdAt).toLocaleString('zh-CN');
      const lastMsgTime = session.lastMessageAt
        ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
        : '无';
      const modelLabel = this.getModelLabel(session.model);

      await ctx.reply(
        `📄 会话详情\n\n` +
        `Topic: <code>${escapeHtml(session.name)}</code>\n` +
        `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
        `模型: ${escapeHtml(modelLabel)}\n` +
        `Claude 上下文: ${session.claudeSessionId ? `<code>${escapeHtml(session.claudeSessionId)}</code>` : '(新会话)'}\n` +
        `创建时间: ${created}\n` +
        `最近活动: ${lastMsgTime}\n` +
        `消息记录: ${session.messageHistory.length} 条`,
        { parse_mode: 'HTML' }
      );
    });
  }

  async handleAttach(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const groupId = ctx.chat!.id;
      const text = (ctx.message as any)?.text || '';
      const targetSessionId = text.replace(/^\/attach(?:@\w+)?\s*/, '').trim();

      try {

      if (!targetSessionId) {
        // 无参数：显示当前 session 信息，方便用户复制
        const currentId = session.claudeSessionId;
        if (currentId) {
          await ctx.reply(
            `🔗 当前 Claude Session:\n<code>${escapeHtml(currentId)}</code>\n\n` +
            `用法: /attach &lt;session_id&gt;\n` +
            `将当前 Topic 链接到指定的 Claude Session。`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.reply(
            `ℹ️ 当前 Topic 没有活跃的 Claude Session。\n\n` +
            `用法: /attach &lt;session_id&gt;\n` +
            `将当前 Topic 链接到指定的 Claude Session。`,
            { parse_mode: 'HTML' }
          );
        }
        return;
      }

      // 检查是否有其他 topic 持有该 session
      const holder = this.stateManager.findSessionHolder(groupId, targetSessionId);
      if (holder && holder.topicId === topicId) {
        await ctx.reply(`ℹ️ 当前 Topic 已经链接到此 Session。`);
        return;
      }

      // 如果其他 topic 持有该 session，检查是否有运行中进程
      if (holder) {
        const holderLockKey = StateManager.topicLockKey(groupId, holder.topicId);
        if (this.claudeClient.isRunning(holderLockKey)) {
          await ctx.reply(
            `❌ Topic「${escapeHtml(holder.name)}」正在使用此 Session 执行任务，请先 /stop 该 Topic 或等待完成。`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        this.stateManager.clearSessionClaudeId(groupId, holder.topicId);
        // 通知被断开的 topic
        this.mq.send(groupId, holder.topicId,
          `⚠️ Claude Session 已被 Topic「${escapeHtml(session.name)}」通过 /attach 接管。\n下次对话将开启新会话。`,
          { parseMode: 'HTML', priority: 'high' }
        ).catch(() => {});
      }

      // 当前 topic 如果也有运行中进程，拒绝切换
      const currentLockKey = StateManager.topicLockKey(groupId, topicId);
      if (this.claudeClient.isRunning(currentLockKey)) {
        await ctx.reply(`❌ 当前 Topic 正在执行任务，请先 /stop 或等待完成。`);
        return;
      }

      // 保存当前 session 的旧 ID，便于用户切回
      const prevSessionId = session.claudeSessionId;

      // 链接新 session
      this.stateManager.setSessionClaudeId(groupId, topicId, targetSessionId);

      let msg = `✅ 已链接到 Claude Session: <code>${escapeHtml(targetSessionId.slice(0, 8))}...</code>`;
      if (holder) {
        msg += `\n(已从 Topic「${escapeHtml(holder.name)}」断开)`;
      }
      if (prevSessionId && prevSessionId !== targetSessionId) {
        msg += `\n\n之前的 Session:\n<code>/attach ${escapeHtml(prevSessionId)}</code>`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });

      } catch (error: any) {
        await ctx.reply(`❌ attach 失败: ${error.message}`).catch(() => {});
      }
    });
  }

  async handleModel(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const topicId = this.getTopicId(ctx);

      if (!topicId) {
        // General: 设置全局默认模型
        const currentModel = this.stateManager.getGroupDefaultModel(groupId);
        const currentLabel = this.getModelLabel(currentModel);

        const buttons = MODEL_OPTIONS.map(opt => {
          const marker = currentModel === opt.id ? ' ✓' : '';
          return Markup.button.callback(`${opt.label}${marker}`, `gmodel:${opt.id}`);
        });
        buttons.push(
          Markup.button.callback(`默认${!currentModel ? ' ✓' : ''}`, 'gmodel:default')
        );

        await ctx.reply(
          `🤖 全局默认模型: ${currentLabel}\n\n` +
          `新创建的 Topic 将使用此模型。\n选择要切换的模型:`,
          Markup.inlineKeyboard([buttons])
        );
      } else {
        // Topic: 设置当前 Topic 模型
        const session = this.stateManager.getOrCreateSession(groupId, topicId, {
          name: `topic-${topicId}`,
          cwd: this.stateManager.getGroupDefaultCwd(groupId),
        });
        const groupModel = this.stateManager.getGroupDefaultModel(groupId);
        const currentLabel = session.model !== undefined
          ? this.getModelLabel(session.model)
          : `${this.getModelLabel(groupModel)} (跟随默认)`;

        const buttons = MODEL_OPTIONS.map(opt => {
          const marker = session.model === opt.id ? ' ✓' : '';
          return Markup.button.callback(`${opt.label}${marker}`, `model:${opt.id}`);
        });
        buttons.push(
          Markup.button.callback(
            `跟随默认${session.model === undefined ? ' ✓' : ''}`,
            'model:follow_default'
          )
        );

        await ctx.reply(
          `🤖 当前模型: ${currentLabel}\n\n选择要切换的模型:`,
          Markup.inlineKeyboard([buttons])
        );
      }
    });
  }

  private getModelLabel(model: string | undefined): string {
    if (!model) return 'Sonnet 4.5 (默认)';
    const found = MODEL_OPTIONS.find(m => m.id === model);
    return found ? found.label : model;
  }

  // ========== Topic 管理命令 ==========

  /**
   * /newtopic - 创建新 Topic
   * 语法: /newtopic <名称> [工作目录]
   */
  async handleNewTopic(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const topicId = this.getTopicId(ctx);

      // 必须在 General Topic 中执行
      if (topicId) {
        await ctx.reply('❌ 此命令只能在 General 话题中使用。');
        return;
      }

      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);

      if (args.length === 0) {
        await ctx.reply(
          '📝 创建新 Topic\n\n' +
          '用法: /newtopic <名称> [工作目录]\n\n' +
          '参数:\n' +
          '  <名称> - Topic 名称（必需）\n' +
          '  [工作目录] - 可选，自定义工作目录路径\n\n' +
          '示例:\n' +
          '  /newtopic claude-bot\n' +
          '  /newtopic my-project /home/jason/projects/my-project'
        );
        return;
      }

      const topicName = args[0];
      const customCwd = args.length > 1 ? args.slice(1).join(' ') : undefined;
      const groupId = ctx.chat!.id;

      try {
        // 解析工作目录
        let cwd: string;
        let dirCreated = false;

        if (customCwd) {
          // 用户指定了自定义路径
          cwd = resolveCustomPath(customCwd, this.stateManager.getGroupDefaultCwd(groupId));

          // 检查并创建目录
          const dirResult = await ensureProjectDir(cwd, this.config.autoCreateProjectDir);
          dirCreated = dirResult.created;

          if (!dirResult.exists && !this.config.autoCreateProjectDir) {
            await ctx.reply(
              `❌ 目录不存在: ${cwd}\n\n` +
              `请先创建目录，或设置 AUTO_CREATE_PROJECT_DIR=true 以自动创建。`
            );
            return;
          }
        } else {
          // 自动推导路径
          const occupiedPaths = this.stateManager.getOccupiedWorkDirs(groupId);
          cwd = await resolveTopicWorkDir(
            topicName,
            this.config.projectsRoot,
            this.config.topicDirNaming,
            occupiedPaths
          );

          // 检查并创建目录
          const dirResult = await ensureProjectDir(cwd, this.config.autoCreateProjectDir);
          dirCreated = dirResult.created;

          if (!dirResult.exists && !this.config.autoCreateProjectDir) {
            await ctx.reply(
              `❌ 推导的目录不存在: ${cwd}\n\n` +
              `请使用 /newtopic ${topicName} <路径> 手动指定目录，\n` +
              `或设置 AUTO_CREATE_PROJECT_DIR=true 以自动创建。`
            );
            return;
          }
        }

        // 调用 Telegram API 创建 Forum Topic
        const forumTopic = await ctx.telegram.createForumTopic(groupId, topicName, {
          icon_color: 0x6FB9F0,  // 蓝色图标
        });

        const newTopicId = forumTopic.message_thread_id;

        // 初始化 Session
        this.stateManager.getOrCreateSession(groupId, newTopicId, {
          name: topicName,
          cwd,
        });
        this.stateManager.setSessionIcon(groupId, newTopicId, forumTopic.icon_color);

        // 发送确认消息到新 Topic
        await ctx.telegram.sendMessage(
          groupId,
          `✅ Topic 已创建\n\n` +
          `名称: <code>${escapeHtml(topicName)}</code>\n` +
          `工作目录: <code>${escapeHtml(cwd)}</code>\n` +
          `${dirCreated ? '📁 目录已自动创建\n' : ''}\n` +
          `直接发送消息即可开始对话。`,
          {
            message_thread_id: newTopicId,
            parse_mode: 'HTML',
            disable_notification: true,
          }
        );

        // 在 General Topic 也回复确认
        await ctx.reply(
          `✅ 成功创建 Topic: ${topicName}\n` +
          `工作目录: ${cwd}\n` +
          `${dirCreated ? '📁 目录已自动创建\n' : ''}\n` +
          `现在可以在新 Topic 中开始对话。`
        );

      } catch (error: any) {
        logger.error('Failed to create topic:', error);
        await ctx.reply(
          `❌ 创建 Topic 失败: ${error.message}\n\n` +
          `请检查:\n` +
          `1. Bot 是否有管理 Topic 的权限\n` +
          `2. 群组是否启用了 Forum Topics 功能\n` +
          `3. Topic 名称是否符合要求（1-128 字符）`
        );
      }
    });
  }

  /**
   * /listtopics - 列出所有 Topic
   */
  async handleListTopics(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const sessions = this.stateManager.getAllSessions(groupId);

      if (sessions.length === 0) {
        await ctx.reply(
          '📋 当前群组还没有 Topic\n\n' +
          '使用 /newtopic <名称> 创建新 Topic'
        );
        return;
      }

      // 并发探测每个 Topic 是否还存在（使用 reopenForumTopic，5 秒超时）
      const deadTopicIds: number[] = [];
      await Promise.allSettled(
        sessions.map(async (s) => {
          try {
            const alive = await Promise.race([
              (async () => {
                try {
                  await ctx.telegram.reopenForumTopic(groupId, s.topicId);
                  return true;
                } catch (err: any) {
                  const desc = err?.response?.description || '';
                  if (desc.includes('not found') || desc.includes('TOPIC_DELETED')) {
                    return false;
                  }
                  return true; // TOPIC_NOT_MODIFIED 等 → 存在
                }
              })(),
              new Promise<boolean>((r) => setTimeout(() => r(true), 5000)), // 超时视为存活
            ]);
            if (!alive) deadTopicIds.push(s.topicId);
          } catch {
            // ignore
          }
        })
      );

      // 清理已删除的 Topic
      if (deadTopicIds.length > 0) {
        for (const topicId of deadTopicIds) {
          this.stateManager.deleteSession(groupId, topicId);
          logger.info(`Cleaned up dead topic: ${topicId}`);
        }
      }

      // 重新获取存活的 sessions
      const liveSessions = this.stateManager.getAllSessions(groupId);

      if (liveSessions.length === 0) {
        await ctx.reply(
          `📋 当前群组还没有 Topic\n` +
          (deadTopicIds.length > 0 ? `\n🗑️ 已自动清理 ${deadTopicIds.length} 个已删除的 Topic\n` : '') +
          `\n使用 /newtopic &lt;名称&gt; 创建新 Topic`
        );
        return;
      }

      const now = Date.now();
      const formatStatus = (lastMessageAt?: number): string => {
        if (!lastMessageAt) return '⚪ 休眠';
        const elapsed = now - lastMessageAt;
        const minutes = Math.floor(elapsed / 60000);

        if (minutes < 10) return '🟢 活跃';
        if (minutes < 1440) return '🟡 空闲';  // 24小时
        return '⚪ 休眠';
      };

      const formatTime = (timestamp: number): string => {
        const elapsed = now - timestamp;
        const minutes = Math.floor(elapsed / 60000);
        const hours = Math.floor(elapsed / 3600000);
        const days = Math.floor(elapsed / 86400000);

        if (minutes < 1) return '刚刚';
        if (minutes < 60) return `${minutes} 分钟前`;
        if (hours < 24) return `${hours} 小时前`;
        return `${days} 天前`;
      };

      const lines = liveSessions.map((s, idx) => {
        const status = formatStatus(s.lastMessageAt);
        const lastActive = s.lastMessageAt || s.createdAt;
        const hasSession = s.claudeSessionId ? 'active' : 'none';

        return (
          `${idx + 1}. ${status} <b>${escapeHtml(s.name)}</b>\n` +
          `   <code>${escapeHtml(s.cwd)}</code>\n` +
          `   ${formatTime(lastActive)} · Claude: ${hasSession}`
        );
      });

      // 每个 Topic 一行按钮：[详情] [归档] [删除]
      const buttons = liveSessions.map(s => [
        Markup.button.callback(`📊 ${s.name.slice(0, 12)}`, `topic:info:${s.topicId}`),
        Markup.button.callback('🗄️ 归档', `topic:archive:${s.topicId}`),
        Markup.button.callback('🗑️ 删除', `topic:delete:${s.topicId}`),
      ]);

      const cleanupNote = deadTopicIds.length > 0
        ? `\n🗑️ 已自动清理 ${deadTopicIds.length} 个已删除的 Topic\n\n`
        : '';

      await ctx.reply(
        `📋 当前群组的 Topic 列表 (共 ${liveSessions.length} 个):\n\n` +
        lines.join('\n\n') +
        (cleanupNote ? '\n\n' + cleanupNote : ''),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons),
        }
      );
    });
  }

  /**
   * /topicinfo - 查看 Topic 详细信息
   * 语法: /topicinfo [topicId]
   */
  async handleTopicInfo(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);
      const currentTopicId = this.getTopicId(ctx);

      let targetTopicId: number;

      if (args.length > 0) {
        // 提供了 topicId 参数
        targetTopicId = parseInt(args[0], 10);
        if (isNaN(targetTopicId)) {
          await ctx.reply('❌ 无效的 Topic ID');
          return;
        }
      } else if (currentTopicId) {
        // 在 Topic 中，未提供参数，显示当前 Topic 信息
        targetTopicId = currentTopicId;
      } else {
        // 在 General Topic 中，未提供参数
        await ctx.reply(
          '用法: /topicinfo <topicId>\n\n' +
          '在 Topic 中可省略参数以查看当前 Topic 信息。\n' +
          '使用 /listtopics 查看所有 Topic ID。'
        );
        return;
      }

      const session = this.stateManager.getSession(groupId, targetTopicId);

      if (!session) {
        await ctx.reply(`❌ 未找到 Topic ID ${targetTopicId} 的会话信息`);
        return;
      }

      const createdDate = new Date(session.createdAt).toLocaleString('zh-CN');
      const lastMsgDate = session.lastMessageAt
        ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
        : '无';

      const recentMessages = session.messageHistory.slice(-3).map(m => {
        const role = m.role === 'user' ? '用户' : '助手';
        const preview = escapeHtml(m.text.slice(0, 100));
        return `  [${role}] ${preview}${m.text.length > 100 ? '...' : ''}`;
      }).join('\n');

      const topicButtons = [
        [
          Markup.button.callback('🗄️ 归档', `topic:archive:${targetTopicId}`),
          Markup.button.callback('🗑️ 删除', `topic:delete:${targetTopicId}`),
        ],
      ];

      await ctx.reply(
        `📊 Topic 详细信息\n\n` +
        `名称: <b>${escapeHtml(session.name)}</b>\n` +
        `Topic 编号: <code>${session.topicId}</code>\n` +
        `群组编号: <code>${session.groupId}</code>\n\n` +
        `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
        `Claude 会话: <code>${escapeHtml(session.claudeSessionId || '无')}</code>\n` +
        `模型: ${this.getModelLabel(session.model)}\n` +
        `Plan Mode: ${session.planMode ? '✅' : '❌'}\n\n` +
        `创建时间: ${createdDate}\n` +
        `最后消息: ${lastMsgDate}\n` +
        `消息历史: ${session.messageHistory.length} 条\n\n` +
        (recentMessages ? `最近对话:\n${recentMessages}` : ''),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(topicButtons),
        }
      );
    });
  }

  /**
   * /renametopic - 重命名 Topic
   * 语法: /renametopic [topicId] <新名称>
   */
  async handleRenameTopic(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);
      const currentTopicId = this.getTopicId(ctx);

      let targetTopicId: number;
      let newName: string;

      if (currentTopicId && args.length === 1) {
        // 在 Topic 中，提供了新名称
        targetTopicId = currentTopicId;
        newName = args[0];
      } else if (args.length >= 2) {
        // 提供了 topicId 和新名称
        targetTopicId = parseInt(args[0], 10);
        if (isNaN(targetTopicId)) {
          await ctx.reply('❌ 无效的 Topic ID');
          return;
        }
        newName = args.slice(1).join(' ');
      } else {
        await ctx.reply(
          '用法:\n' +
          '  在 Topic 中: /renametopic <新名称>\n' +
          '  在 General 中: /renametopic <topicId> <新名称>'
        );
        return;
      }

      const session = this.stateManager.getSession(groupId, targetTopicId);

      if (!session) {
        await ctx.reply(`❌ 未找到 Topic ID ${targetTopicId} 的会话信息`);
        return;
      }

      // 验证新名称
      if (newName.length < 1 || newName.length > 128) {
        await ctx.reply('❌ Topic 名称长度必须在 1-128 字符之间');
        return;
      }

      try {
        // 调用 Telegram API 重命名
        await ctx.telegram.editForumTopic(groupId, targetTopicId, {
          name: newName,
        });

        // 更新本地 Session
        this.stateManager.setSessionName(groupId, targetTopicId, newName);

        await ctx.reply(
          `✅ Topic 已重命名\n\n` +
          `旧名称: ${escapeHtml(session.name)}\n` +
          `新名称: ${escapeHtml(newName)}\n\n` +
          `工作目录未改变: ${escapeHtml(session.cwd)}`
        );

      } catch (error: any) {
        logger.error('Failed to rename topic:', error);
        await ctx.reply(`❌ 重命名失败: ${error.message}`);
      }
    });
  }

  /**
   * /deletetopic - 删除或归档 Topic
   * 语法: /deletetopic <topicId> [--archive]
   */
  async handleDeleteTopic(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);

      if (args.length === 0) {
        await ctx.reply(
          '用法: /deletetopic &lt;topicId&gt;\n\n' +
          '或使用 /listtopics 通过按钮操作。',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const targetTopicId = parseInt(args[0], 10);

      if (isNaN(targetTopicId)) {
        await ctx.reply('❌ 无效的 Topic ID');
        return;
      }

      const session = this.stateManager.getSession(groupId, targetTopicId);

      if (!session) {
        await ctx.reply(`❌ 未找到该 Topic 的会话信息`);
        return;
      }

      // 弹出确认按钮
      await ctx.reply(
        `⚠️ 对 Topic <b>${escapeHtml(session.name)}</b> 执行什么操作?\n\n` +
        `工作目录: <code>${escapeHtml(session.cwd)}</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🗄️ 归档（保留数据）', `topic:archive:${targetTopicId}`),
            ],
            [
              Markup.button.callback('🗑️ 彻底删除', `topic:confirmdelete:${targetTopicId}`),
            ],
            [
              Markup.button.callback('取消', `topic:cancel`),
            ],
          ]),
        }
      );
    });
  }

  // ========== Topic 按钮回调处理 ==========

  /**
   * 处理 topic:info:<topicId> 回调
   */
  async handleTopicInfoCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const createdDate = new Date(session.createdAt).toLocaleString('zh-CN');
    const lastMsgDate = session.lastMessageAt
      ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
      : '无';

    await ctx.answerCbQuery();
    await ctx.reply(
      `📊 <b>${escapeHtml(session.name)}</b>\n\n` +
      `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
      `Claude 会话: <code>${escapeHtml(session.claudeSessionId || '无')}</code>\n` +
      `模型: ${this.getModelLabel(session.model)}\n` +
      `创建: ${createdDate}\n` +
      `最后活动: ${lastMsgDate}\n` +
      `消息: ${session.messageHistory.length} 条`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🗄️ 归档', `topic:archive:${topicId}`),
            Markup.button.callback('🗑️ 删除', `topic:delete:${topicId}`),
          ],
        ]),
      }
    );
  }

  /**
   * 处理 topic:delete:<topicId> 回调 — 弹出确认
   */
  async handleTopicDeleteCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `⚠️ 确认删除 <b>${escapeHtml(session.name)}</b>?\n\n` +
      `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
      `此操作不可恢复！`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ 确认删除', `topic:confirmdelete:${topicId}`),
            Markup.button.callback('❌ 取消', `topic:cancel`),
          ],
        ]),
      }
    );
  }

  /**
   * 处理 topic:confirmdelete:<topicId> 回调 — 执行删除
   */
  async handleTopicConfirmDeleteCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const name = session.name;

    try {
      this.stateManager.deleteSession(groupId, topicId);
      await ctx.telegram.deleteForumTopic(groupId, topicId).catch(() => {});
      await ctx.answerCbQuery('✅ 已删除');
      await ctx.editMessageText(`🗑️ Topic <b>${escapeHtml(name)}</b> 已彻底删除`, { parse_mode: 'HTML' });
    } catch (error: any) {
      logger.error('Failed to delete topic:', error);
      await ctx.answerCbQuery(`❌ 删除失败: ${error.message}`);
    }
  }

  /**
   * 处理 topic:archive:<topicId> 回调 — 执行归档
   */
  async handleTopicArchiveCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const name = session.name;

    try {
      const userId = ctx.from?.id;
      this.stateManager.archiveSession(groupId, topicId, userId, '按钮归档');
      await ctx.telegram.closeForumTopic(groupId, topicId).catch(() => {});
      await ctx.answerCbQuery('🗄️ 已归档');
      await ctx.editMessageText(`🗄️ Topic <b>${escapeHtml(name)}</b> 已归档\n数据已保留，可恢复。`, { parse_mode: 'HTML' });
    } catch (error: any) {
      logger.error('Failed to archive topic:', error);
      await ctx.answerCbQuery(`❌ 归档失败: ${error.message}`);
    }
  }

  /**
   * 处理 topic:cancel 回调
   */
  async handleTopicCancelCallback(ctx: any): Promise<void> {
    await ctx.answerCbQuery('已取消');
    await ctx.editMessageText('已取消操作。');
  }

  // ========== /topics 多层级按钮管理 ==========

  private formatStatus(lastMessageAt?: number): string {
    if (!lastMessageAt) return '⚪';
    const elapsed = Date.now() - lastMessageAt;
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 10) return '🟢';
    if (minutes < 1440) return '🟡';
    return '⚪';
  }

  private formatTime(timestamp: number): string {
    const elapsed = Date.now() - timestamp;
    const minutes = Math.floor(elapsed / 60000);
    const hours = Math.floor(elapsed / 3600000);
    const days = Math.floor(elapsed / 86400000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  }

  /**
   * /topics — 多层级 Topic 管理入口（一级列表）
   */
  async handleTopics(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      await this.sendTopicListMessage(ctx, groupId);
    });
  }

  /**
   * 发送/编辑一级列表消息
   */
  private async sendTopicListMessage(ctx: Context, groupId: number, editMessageId?: number): Promise<void> {
    const sessions = this.stateManager.getAllSessions(groupId);

    // 并发探测死 Topic
    const deadTopicIds: number[] = [];
    await Promise.allSettled(
      sessions.map(async (s) => {
        try {
          const alive = await Promise.race([
            (async () => {
              try {
                await ctx.telegram.reopenForumTopic(groupId, s.topicId);
                return true;
              } catch (err: any) {
                const desc = err?.response?.description || '';
                if (desc.includes('not found') || desc.includes('TOPIC_DELETED')) {
                  return false;
                }
                return true;
              }
            })(),
            new Promise<boolean>((r) => setTimeout(() => r(true), 5000)),
          ]);
          if (!alive) deadTopicIds.push(s.topicId);
        } catch { /* ignore */ }
      })
    );

    if (deadTopicIds.length > 0) {
      for (const topicId of deadTopicIds) {
        this.stateManager.deleteSession(groupId, topicId);
        logger.info(`Cleaned up dead topic: ${topicId}`);
      }
    }

    const liveSessions = this.stateManager.getAllSessions(groupId);

    // 分离父子关系：顶层 topic + 子 topic
    // 父已不存在的子 topic 视为顶层（孤儿提升）
    const liveTopicIds = new Set(liveSessions.map(s => s.topicId));
    const topLevel = liveSessions.filter(s => !s.parentTopicId || !liveTopicIds.has(s.parentTopicId));
    const childMap = new Map<number, typeof liveSessions>();
    for (const s of liveSessions) {
      if (s.parentTopicId && liveTopicIds.has(s.parentTopicId)) {
        const arr = childMap.get(s.parentTopicId) || [];
        arr.push(s);
        childMap.set(s.parentTopicId, arr);
      }
    }

    if (liveSessions.length === 0) {
      const text = '📋 当前群组还没有 Topic' +
        (deadTopicIds.length > 0 ? `\n\n🗑️ 已自动清理 ${deadTopicIds.length} 个已删除的 Topic` : '');
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ 创建新 Topic', 'topics:create')],
      ]);
      if (editMessageId) {
        await ctx.telegram.editMessageText(groupId, editMessageId, undefined, text, { ...keyboard });
      } else {
        await ctx.reply(text, keyboard);
      }
      return;
    }

    // 构建列表文本
    const lines: string[] = [];
    let idx = 0;
    for (const s of topLevel) {
      idx++;
      const status = this.formatStatus(s.lastMessageAt);
      const lastActive = s.lastMessageAt || s.createdAt;
      lines.push(
        `${idx}. ${status} <b>${escapeHtml(s.name)}</b>\n` +
        `   <code>${escapeHtml(s.cwd)}</code>\n` +
        `   ${this.formatTime(lastActive)}`
      );
      // 子 topic
      const children = childMap.get(s.topicId) || [];
      for (let ci = 0; ci < children.length; ci++) {
        const c = children[ci];
        const cStatus = this.formatStatus(c.lastMessageAt);
        const cActive = c.lastMessageAt || c.createdAt;
        const prefix = ci === children.length - 1 ? '└──' : '├──';
        lines.push(
          `   ${prefix} ${cStatus} <b>${escapeHtml(c.name)}</b>\n` +
          `       <code>${escapeHtml(c.cwd)}</code>\n` +
          `       ${this.formatTime(cActive)}`
        );
      }
    }

    const cleanupNote = deadTopicIds.length > 0
      ? `\n\n🗑️ 已自动清理 ${deadTopicIds.length} 个已删除的 Topic`
      : '';

    const text = `📋 Topic 列表 (共 ${liveSessions.length} 个)\n\n` +
      lines.join('\n\n') + cleanupNote;

    // 构建按钮：每个 topic 一个按钮（包括子 topic）
    const buttons: any[][] = [];
    // 每行 2-3 个按钮
    let row: any[] = [];
    for (const s of topLevel) {
      row.push(Markup.button.callback(
        `${this.formatStatus(s.lastMessageAt)} ${s.name.slice(0, 16)}`,
        `topics:select:${s.topicId}`
      ));
      if (row.length >= 3) { buttons.push(row); row = []; }

      // 子 topic 按钮
      for (const c of (childMap.get(s.topicId) || [])) {
        row.push(Markup.button.callback(
          `  ↳ ${c.name.slice(0, 14)}`,
          `topics:select:${c.topicId}`
        ));
        if (row.length >= 3) { buttons.push(row); row = []; }
      }
    }
    if (row.length > 0) buttons.push(row);

    // 底部操作行
    buttons.push([
      Markup.button.callback('➕ 创建新 Topic', 'topics:create'),
      Markup.button.callback('🔄 刷新', 'topics:refresh'),
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);

    if (editMessageId) {
      await ctx.telegram.editMessageText(groupId, editMessageId, undefined, text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  }

  /**
   * topics:select:<topicId> — 二级详情/操作菜单
   */
  async handleTopicsSelectCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    await ctx.answerCbQuery();

    const createdDate = new Date(session.createdAt).toLocaleString('zh-CN');
    const lastMsgDate = session.lastMessageAt
      ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
      : '无';
    const modelLabel = this.getModelLabel(session.model);

    let parentInfo = '';
    if (session.parentTopicId) {
      const parent = this.stateManager.getSession(groupId, session.parentTopicId);
      parentInfo = `\n父 Topic: <b>${escapeHtml(parent?.name || String(session.parentTopicId))}</b>`;
    }
    let branchInfo = '';
    if (session.worktreeBranch) {
      branchInfo = `\n分支: <code>${escapeHtml(session.worktreeBranch)}</code>`;
    }

    // 子 topic 列表
    const children = this.stateManager.getChildSessions(groupId, topicId);
    let childInfo = '';
    if (children.length > 0) {
      childInfo = `\n\n子 Topic (${children.length}):\n` +
        children.map(c => `  • ${escapeHtml(c.name)}`).join('\n');
    }

    const text =
      `📊 <b>${escapeHtml(session.name)}</b>\n\n` +
      `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
      `Claude 会话: <code>${escapeHtml(session.claudeSessionId || '无')}</code>\n` +
      `模型: ${modelLabel}\n` +
      `创建: ${createdDate}\n` +
      `最后活动: ${lastMsgDate}\n` +
      `消息: ${session.messageHistory.length} 条` +
      parentInfo + branchInfo + childInfo;

    const buttons: any[][] = [
      [
        Markup.button.callback('🗄️ 归档', `topics:archive:${topicId}`),
        Markup.button.callback('🗑️ 删除', `topics:delete:${topicId}`),
      ],
      [
        Markup.button.callback('⬅️ 返回列表', 'topics:back'),
      ],
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  /**
   * topics:back — 返回一级列表
   */
  async handleTopicsBackCallback(ctx: any): Promise<void> {
    const groupId = ctx.chat!.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    await ctx.answerCbQuery();
    await this.sendTopicListMessage(ctx, groupId, messageId);
  }

  /**
   * topics:refresh — 刷新列表
   */
  async handleTopicsRefreshCallback(ctx: any): Promise<void> {
    const groupId = ctx.chat!.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    await ctx.answerCbQuery('🔄 刷新中...');
    await this.sendTopicListMessage(ctx, groupId, messageId);
  }

  /**
   * topics:create — 启动创建流程（文本收集模式）
   */
  async handleTopicsCreateCallback(ctx: any): Promise<void> {
    const groupId = ctx.chat!.id;
    await ctx.answerCbQuery();

    const text = '📝 请输入项目名称\n\n下一条消息将作为 Topic 名称:';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 取消', 'topics:cancel')],
    ]);
    await ctx.editMessageText(text, keyboard);

    const messageId = ctx.callbackQuery?.message?.message_id;
    this.pendingTextInput.set(groupId, {
      type: 'create',
      chatId: groupId,
      messageId,
    });
  }

  /**
   * topics:delete:<topicId> — 删除确认视图
   */
  async handleTopicsDeleteCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const children = this.stateManager.getChildSessions(groupId, topicId);

    await ctx.answerCbQuery();

    if (children.length > 0) {
      // 有子 Topic，提供选择
      const childNames = children.map(c => `  • ${escapeHtml(c.name)}`).join('\n');
      const buttons = [
        [Markup.button.callback('🗑️ 全部删除（含子 Topic）', `topics:confirmdeleteall:${topicId}`)],
        [Markup.button.callback('❌ 取消', `topics:backto:${topicId}`)],
      ];
      await ctx.editMessageText(
        `⚠️ <b>${escapeHtml(session.name)}</b> 有 ${children.length} 个子 Topic:\n\n` +
        `${childNames}\n\n` +
        `无法单独删除父 Topic，请选择操作:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons),
        }
      );
    } else {
      await ctx.editMessageText(
        `⚠️ 确认删除 <b>${escapeHtml(session.name)}</b>?\n\n` +
        `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
        `此操作不可恢复！`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ 确认删除', `topics:confirmdelete:${topicId}`),
              Markup.button.callback('❌ 取消', `topics:backto:${topicId}`),
            ],
          ]),
        }
      );
    }
  }

  /**
   * topics:confirmdelete:<topicId> — 执行单个删除
   */
  async handleTopicsConfirmDeleteCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const name = session.name;

    try {
      this.stateManager.deleteSession(groupId, topicId);
      await ctx.telegram.deleteForumTopic(groupId, topicId).catch(() => {});
      await ctx.answerCbQuery('✅ 已删除');
      await ctx.editMessageText(
        `🗑️ Topic <b>${escapeHtml(name)}</b> 已彻底删除`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ 返回列表', 'topics:back')],
          ]),
        }
      );
    } catch (error: any) {
      logger.error('Failed to delete topic:', error);
      await ctx.answerCbQuery(`❌ 删除失败: ${error.message}`);
    }
  }

  /**
   * topics:confirmdeleteall:<topicId> — 级联删除父 + 所有子 Topic
   */
  async handleTopicsConfirmDeleteAllCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const name = session.name;
    const children = this.stateManager.getChildSessions(groupId, topicId);

    try {
      // 先删除所有子 Topic
      for (const child of children) {
        this.stateManager.deleteSession(groupId, child.topicId);
        await ctx.telegram.deleteForumTopic(groupId, child.topicId).catch(() => {});
      }
      // 再删除父 Topic
      this.stateManager.deleteSession(groupId, topicId);
      await ctx.telegram.deleteForumTopic(groupId, topicId).catch(() => {});

      await ctx.answerCbQuery('✅ 已全部删除');
      await ctx.editMessageText(
        `🗑️ Topic <b>${escapeHtml(name)}</b> 及 ${children.length} 个子 Topic 已彻底删除`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ 返回列表', 'topics:back')],
          ]),
        }
      );
    } catch (error: any) {
      logger.error('Failed to delete topics:', error);
      await ctx.answerCbQuery(`❌ 删除失败: ${error.message}`);
    }
  }

  /**
   * topics:archive:<topicId> — 执行归档
   */
  async handleTopicsArchiveCallback(ctx: any): Promise<void> {
    const topicId = parseInt(ctx.match[1], 10);
    const groupId = ctx.chat!.id;

    const session = this.stateManager.getSession(groupId, topicId);
    if (!session) {
      await ctx.answerCbQuery('❌ Topic 不存在');
      return;
    }

    const children = this.stateManager.getChildSessions(groupId, topicId);
    const name = session.name;

    try {
      const userId = ctx.from?.id;

      // 如果有子 Topic，一并归档
      if (children.length > 0) {
        for (const child of children) {
          this.stateManager.archiveSession(groupId, child.topicId, userId, '随父 Topic 归档');
          await ctx.telegram.closeForumTopic(groupId, child.topicId).catch(() => {});
        }
      }

      this.stateManager.archiveSession(groupId, topicId, userId, '按钮归档');
      await ctx.telegram.closeForumTopic(groupId, topicId).catch(() => {});
      await ctx.answerCbQuery('🗄️ 已归档');

      const childNote = children.length > 0 ? `\n（含 ${children.length} 个子 Topic）` : '';
      await ctx.editMessageText(
        `🗄️ Topic <b>${escapeHtml(name)}</b> 已归档${childNote}\n数据已保留，可恢复。`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ 返回列表', 'topics:back')],
          ]),
        }
      );
    } catch (error: any) {
      logger.error('Failed to archive topic:', error);
      await ctx.answerCbQuery(`❌ 归档失败: ${error.message}`);
    }
  }

  /**
   * topics:backto:<topicId> — 返回某 topic 的二级菜单
   */
  async handleTopicsBackToCallback(ctx: any): Promise<void> {
    // 复用 select 逻辑
    await this.handleTopicsSelectCallback(ctx);
  }

  /**
   * topics:cancel — 取消操作并返回列表
   */
  async handleTopicsCancelCallback(ctx: any): Promise<void> {
    const groupId = ctx.chat!.id;
    // 清除 pending 文本收集
    this.pendingTextInput.delete(groupId);
    await ctx.answerCbQuery('已取消');
    const messageId = ctx.callbackQuery?.message?.message_id;
    await this.sendTopicListMessage(ctx, groupId, messageId);
  }

  /**
   * 处理 General 话题中的文本输入（创建 Topic）
   * 由 handlers.ts 调用
   * @returns true 表示已处理，false 表示没有 pending 操作
   */
  async handleGeneralText(ctx: Context, groupId: number, text: string): Promise<boolean> {
    const pending = this.pendingTextInput.get(groupId);
    if (!pending) return false;

    // 清除 pending 状态
    this.pendingTextInput.delete(groupId);

    await this.executeTopicCreate(ctx, groupId, text, pending.messageId);

    return true;
  }

  /**
   * 执行 Topic 创建
   */
  private async executeTopicCreate(ctx: Context, groupId: number, topicName: string, promptMessageId: number): Promise<void> {
    topicName = topicName.trim();
    if (!topicName || topicName.length > 128) {
      await ctx.telegram.editMessageText(groupId, promptMessageId, undefined,
        '❌ 名称无效（1-128 字符）');
      return;
    }

    try {
      // 自动推导路径
      const occupiedPaths = this.stateManager.getOccupiedWorkDirs(groupId);
      const cwd = await resolveTopicWorkDir(
        topicName,
        this.config.projectsRoot,
        this.config.topicDirNaming,
        occupiedPaths
      );

      const dirResult = await ensureProjectDir(cwd, this.config.autoCreateProjectDir);

      if (!dirResult.exists && !this.config.autoCreateProjectDir) {
        await ctx.telegram.editMessageText(groupId, promptMessageId, undefined,
          `❌ 推导的目录不存在: ${cwd}\n设置 AUTO_CREATE_PROJECT_DIR=true 以自动创建。`);
        return;
      }

      // 创建 Forum Topic
      const forumTopic = await ctx.telegram.createForumTopic(groupId, topicName, {
        icon_color: 0x6FB9F0,
      });

      const newTopicId = forumTopic.message_thread_id;

      this.stateManager.getOrCreateSession(groupId, newTopicId, {
        name: topicName,
        cwd,
      });
      this.stateManager.setSessionIcon(groupId, newTopicId, forumTopic.icon_color);

      // 在新 Topic 中发送欢迎
      await ctx.telegram.sendMessage(
        groupId,
        `✅ Topic 已创建\n\n` +
        `名称: <code>${escapeHtml(topicName)}</code>\n` +
        `工作目录: <code>${escapeHtml(cwd)}</code>\n` +
        `${dirResult.created ? '📁 目录已自动创建\n' : ''}\n` +
        `直接发送消息即可开始对话。`,
        { message_thread_id: newTopicId, parse_mode: 'HTML', disable_notification: true }
      );

      // 编辑提示消息为确认
      await ctx.telegram.editMessageText(groupId, promptMessageId, undefined,
        `✅ 成功创建 Topic: <b>${escapeHtml(topicName)}</b>\n工作目录: <code>${escapeHtml(cwd)}</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ 返回列表', 'topics:back')],
          ]),
        }
      );
    } catch (error: any) {
      logger.error('Failed to create topic:', error);
      await ctx.telegram.editMessageText(groupId, promptMessageId, undefined,
        `❌ 创建失败: ${error.message}`).catch(() => {});
    }
  }

  /**
   * 启动独立的 claude -p 非交互进程，用完即弃
   * 不占用 topic session/lock，不写入 messageHistory，进程结束自动销毁
   */
  private spawnSkillProcess(
    skillName: string,
    prompt: string,
    cwd: string,
    chatId: number,
    topicId: number,
    options?: { maxTurns?: number },
  ): void {
    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--allowedTools', 'Bash',
      '--max-turns', String(options?.maxTurns ?? 15),
      '--no-session-persistence',
    ], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('exit', async (code: number | null) => {
      try {
        if (code === 0) {
          // --output-format json → { result: "..." }
          let result: string;
          try {
            result = JSON.parse(stdout).result || stdout;
          } catch {
            result = stdout.trim();
          }
          if (result) {
            await this.mq.sendLong(chatId, topicId, result);
          }
        } else {
          const errMsg = stderr.trim() || `退出码 ${code}`;
          await this.mq.send(chatId, topicId, `❌ ${skillName} 失败: ${errMsg}`);
        }
      } catch (e: any) {
        logger.error(`${skillName} result delivery failed:`, e.message);
      }
    });

    child.on('error', (err: Error) => {
      this.mq.send(chatId, topicId, `❌ ${skillName} 启动失败: ${err.message}`).catch(() => {});
    });
  }

  /**
   * /qdev - 快速创建开发分支和任务（独立非交互 Claude 进程）
   */
  async handleQdev(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const text = (ctx.message as any)?.text || '';
      const description = text.replace(/^\/qdev\s*/, '').trim();

      if (!description) {
        await ctx.reply('用法: /qdev <任务描述>\n\n例如: /qdev 修复统计负数');
        return;
      }

      const chatId = ctx.chat!.id;

      const skillPath = join(homedir(), '.claude/skills/qdev/SKILL.md');
      let skillContent: string;
      try {
        skillContent = await readFile(skillPath, 'utf-8');
      } catch {
        await ctx.reply('❌ 未找到 qdev skill 文件: ~/.claude/skills/qdev/SKILL.md');
        return;
      }

      // 提取 frontmatter 之后的内容
      const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
      const prompt = (bodyMatch ? bodyMatch[1] : skillContent)
        .replace('{{SKILL_ARGS}}', description);

      await ctx.reply(`🚀 正在后台执行 qdev: ${description}`);

      // Fire-and-forget: 独立 claude -p 进程，不占用当前 topic 的 session/lock
      // qdev 只需：1 turn 生成分支名 + 1 turn 跑脚本 + 1 turn 输出确认 = 3 turns
      this.spawnSkillProcess('qdev', prompt, session.cwd, chatId, topicId, { maxTurns: 5 });
    });
  }

  /**
   * /commit - 审查代码变更后自动提交（独立非交互 Claude 进程）
   */
  async handleCommit(ctx: Context): Promise<void> {
    await this.requireTopic(ctx, async (session, topicId) => {
      const text = (ctx.message as any)?.text || '';
      const message = text.replace(/^\/commit\s*/, '').trim();

      const chatId = ctx.chat!.id;

      const skillPath = join(homedir(), '.claude/skills/commit/SKILL.md');
      let skillContent: string;
      try {
        skillContent = await readFile(skillPath, 'utf-8');
      } catch {
        await ctx.reply('❌ 未找到 commit skill 文件: ~/.claude/skills/commit/SKILL.md');
        return;
      }

      // 提取 frontmatter 之后的内容
      const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
      const prompt = (bodyMatch ? bodyMatch[1] : skillContent)
        .replace('{{SKILL_ARGS}}', message);

      await ctx.reply(`📝 正在后台审查并提交代码...${message ? `\n备注: ${message}` : ''}`);

      // Fire-and-forget: 独立 claude -p 进程，不占用当前 topic 的 session/lock
      this.spawnSkillProcess('commit', prompt, session.cwd, chatId, topicId);
    });
  }

  /**
   * /merge - 合并 worktree 分支到 main 并清理资源（独立非交互 Claude 进程）
   */
  async handleMerge(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const text = (ctx.message as any)?.text || '';
      const args = text.replace(/^\/merge\s*/, '').trim();

      if (!args) {
        await ctx.reply(
          '用法: /merge <topic名称或分支名>\n\n' +
          '例如:\n' +
          '  /merge fix/stats-negative-value\n' +
          '  /merge ClaudeBot/refactor/simplify-topic-buttons'
        );
        return;
      }

      const groupId = ctx.chat!.id;
      const chatId = groupId;
      const currentTopicId = this.getTopicId(ctx);

      // 查找匹配的 session
      const allSessions = this.stateManager.getAllSessions(groupId);
      let targetSession = allSessions.find(s => s.worktreeBranch === args)
        || allSessions.find(s => s.name === args)
        || allSessions.find(s => s.name.toLowerCase().includes(args.toLowerCase()));

      if (!targetSession) {
        await ctx.reply(`❌ 未找到匹配的 Topic: "${args}"`);
        return;
      }

      if (!targetSession.worktreeBranch) {
        await ctx.reply(`❌ Topic "${targetSession.name}" 不是 worktree 分支，无法执行合并`);
        return;
      }

      // 预计算 main worktree 路径
      let mainCwd: string;
      try {
        const execFileAsync = promisify(execFileCb);
        const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd: targetSession.cwd });
        const mainLine = stdout.split('\n').find(line => /\[(main|master)\]/.test(line));
        if (!mainLine) {
          await ctx.reply('❌ 未找到 main/master 分支的 worktree');
          return;
        }
        mainCwd = mainLine.split(/\s+/)[0];
      } catch (err: any) {
        await ctx.reply(`❌ 获取 main worktree 路径失败: ${err.message}`);
        return;
      }

      // 加载 skill
      const skillPath = join(homedir(), '.claude/skills/merge/SKILL.md');
      let skillContent: string;
      try {
        skillContent = await readFile(skillPath, 'utf-8');
      } catch {
        await ctx.reply('❌ 未找到 merge skill 文件: ~/.claude/skills/merge/SKILL.md');
        return;
      }

      // 提取 frontmatter 之后的内容，替换模板变量
      const bodyMatch = skillContent.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
      const prompt = (bodyMatch ? bodyMatch[1] : skillContent)
        .replaceAll('{{TARGET_TOPIC_ID}}', String(targetSession.topicId))
        .replaceAll('{{TARGET_BRANCH}}', targetSession.worktreeBranch)
        .replaceAll('{{TARGET_CWD}}', targetSession.cwd)
        .replaceAll('{{MAIN_CWD}}', mainCwd);

      await ctx.reply(
        `🔄 正在后台执行合并清理: ${targetSession.name}\n` +
        `分支: ${targetSession.worktreeBranch}\n` +
        `工作目录: ${targetSession.cwd}`
      );

      // Fire-and-forget: 独立 claude -p 进程，cwd 设为 main worktree（目标 worktree 会被删除）
      const replyTopicId = currentTopicId || targetSession.topicId;
      this.spawnSkillProcess('merge', prompt, mainCwd, chatId, replyTopicId, { maxTurns: 5 });
    });
  }
}
