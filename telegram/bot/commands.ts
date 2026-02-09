/**
 * Telegram Bot 命令处理器（Group + Forum Topics 模式）
 */

import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { StateManager } from './state.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { escapeHtml } from './message-utils.js';
import { StreamEvent } from '../types/index.js';
import { stat } from 'fs/promises';
import { resolve } from 'path';
import { timingSafeEqual } from 'crypto';
import { updateAuthorizedChatId, getAuthorizedChatId } from '../utils/env.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';

export const MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

export class CommandHandler {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;
  private messageHandler: MessageHandler;

  constructor(stateManager: StateManager, claudeClient: ClaudeClient, messageHandler: MessageHandler) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
    this.messageHandler = messageHandler;
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
      const session = this.stateManager.getOrCreateSession(groupId, topicId, {
        name: `topic-${topicId}`,
        cwd: this.stateManager.getGroupDefaultCwd(groupId),
      });
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
        const session = this.stateManager.getOrCreateSession(groupId, topicId, {
          name: `topic-${topicId}`,
          cwd: this.stateManager.getGroupDefaultCwd(groupId),
        });
        await ctx.reply(
          `👋 Claude Code 已就绪\n\n` +
          `工作目录: ${session.cwd}\n\n` +
          `直接发送消息即可开始对话。\n` +
          `可用命令: /cd /clear /compact /rewind /plan /stop /model /info`
        );
      } else {
        // General topic
        const defaultCwd = this.stateManager.getGroupDefaultCwd(ctx.chat!.id);
        const sessionCount = this.stateManager.getAllSessions(ctx.chat!.id).length;
        await ctx.reply(
          `👋 欢迎使用 Claude Code Telegram Bot！\n\n` +
          `默认工作目录: ${defaultCwd}\n` +
          `活跃 Topic 数: ${sessionCount}\n\n` +
          `使用方法:\n` +
          `1. 在此 Group 中创建 Topic（每个 Topic = 一个独立会话）\n` +
          `2. 在 Topic 中直接发消息与 Claude 对话\n` +
          `3. 不同 Topic 可以同时工作，互不干扰\n\n` +
          `General 命令: /login /start /help /status /setcwd`
        );
      }
    });
  }

  async handleHelp(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      await ctx.reply(
        `🤖 Claude Code Telegram Bot 帮助\n\n` +
        `<b>General 话题命令</b>\n` +
        `/login &lt;token&gt; - 绑定 Bot 到此 Group\n` +
        `/start - 显示欢迎信息\n` +
        `/help - 显示此帮助\n` +
        `/status - 全局状态概览\n` +
        `/setcwd &lt;path&gt; - 设置新 Topic 默认工作目录\n\n` +
        `<b>Topic 内命令</b>\n` +
        `/cd &lt;path&gt; - 切换工作目录\n` +
        `/clear - 清空 Claude 上下文\n` +
        `/compact - 压缩上下文\n` +
        `/rewind - 撤销最后一轮对话\n` +
        `/plan &lt;msg&gt; - Plan 模式（只规划不执行）\n` +
        `/stop - 停止当前任务\n` +
        `/model - 切换 Claude 模型\n` +
        `/info - 查看会话详情\n\n` +
        `<b>使用方法</b>\n` +
        `• 每个 Topic = 一个独立的 Claude 会话\n` +
        `• 在 Topic 中直接发消息即可对话\n` +
        `• 不同 Topic 可以同时执行任务\n` +
        `• 创建新 Topic 自动初始化新会话`,
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

  async handleSetCwd(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const groupId = ctx.chat!.id;
      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);

      if (args.length === 0) {
        const currentCwd = this.stateManager.getGroupDefaultCwd(groupId);
        await ctx.reply(`当前默认工作目录: <code>${escapeHtml(currentCwd)}</code>`, { parse_mode: 'HTML' });
        return;
      }

      const input = args[0];
      const currentCwd = this.stateManager.getGroupDefaultCwd(groupId);
      const resolvedPath = resolve(currentCwd, input);

      try {
        const s = await stat(resolvedPath);
        if (!s.isDirectory()) {
          await ctx.reply(`❌ 不是目录: ${resolvedPath}`);
          return;
        }
        this.stateManager.setGroupDefaultCwd(groupId, resolvedPath);
        await ctx.reply(`✅ 默认工作目录已设为: <code>${escapeHtml(resolvedPath)}</code>`, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(`❌ 目录不存在: ${resolvedPath}`);
      }
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
          postTokens = event.usage.input_tokens;
        }
      };

      try {
        const lockKey = session.claudeSessionId || session.id;
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
      const lockKey = session.claudeSessionId || session.id;
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
        `Claude 上下文: ${session.claudeSessionId ? `<code>${escapeHtml(session.claudeSessionId.slice(0, 8))}...</code>` : '(新会话)'}\n` +
        `创建时间: ${created}\n` +
        `最近活动: ${lastMsgTime}\n` +
        `消息记录: ${session.messageHistory.length} 条`,
        { parse_mode: 'HTML' }
      );
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
}
