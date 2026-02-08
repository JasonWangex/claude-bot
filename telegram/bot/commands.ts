/**
 * Telegram Bot 命令处理器
 */

import { Context } from 'telegraf';
import { StateManager } from './state.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { SessionPanel } from './session-panel.js';
import { sendLongMessage, escapeHtml } from './message-utils.js';
import { StreamEvent } from '../types/index.js';
import { stat } from 'fs/promises';
import { resolve } from 'path';
import { timingSafeEqual } from 'crypto';
import { updateAuthorizedChatId, getAuthorizedChatId } from '../utils/env.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';

export class CommandHandler {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;
  private messageHandler: MessageHandler;
  private sessionPanel: SessionPanel;

  constructor(stateManager: StateManager, claudeClient: ClaudeClient, messageHandler: MessageHandler, sessionPanel: SessionPanel) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
    this.messageHandler = messageHandler;
    this.sessionPanel = sessionPanel;
  }

  private getAccessToken(): string {
    return process.env.BOT_ACCESS_TOKEN || '';
  }

  private async requireAuth(ctx: Context, handler: () => Promise<void>): Promise<void> {
    if (!ctx.from || !ctx.chat || !checkAuth(ctx, this.stateManager)) {
      const authorizedChatId = getAuthorizedChatId();
      await ctx.reply(
        '❌ 未授权访问\n\n' +
        (authorizedChatId
          ? '此 Bot 仅限特定用户使用。'
          : '请先使用 /login <token> 进行鉴权。')
      );
      return;
    }
    await handler();
  }

  async handleLogin(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) return;
    const userId = ctx.from.id;
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

    // Constant-time comparison to prevent timing attacks
    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(accessToken);
    if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
      await ctx.reply('❌ 访问令牌无效。');
      return;
    }

    this.stateManager.setAuthorized(userId, true);

    const currentChatId = getAuthorizedChatId();

    if (!currentChatId) {
      const success = updateAuthorizedChatId(chatId);
      if (success) {
        logger.info(`Auto-bound Chat ID ${chatId} to Bot`);
        await ctx.reply(
          '✅ 鉴权成功！\n\n' +
          `Bot 已绑定到您的账号（Chat ID: ${chatId}）。\n` +
          `从现在起，只有您可以使用此 Bot。\n\n` +
          `如需解绑，请手动编辑 .env 文件清除 AUTHORIZED_CHAT_ID。`
        );
      } else {
        await ctx.reply('✅ 鉴权成功！现在可以使用 Bot 了。');
      }
    } else if (currentChatId === chatId) {
      await ctx.reply(
        '✅ 鉴权成功！\n\n' +
        `Bot 已绑定到您的账号（Chat ID: ${chatId}）。`
      );
    } else {
      await ctx.reply(
        '❌ 此 Bot 已绑定到其他用户。\n\n' +
        '如需更改绑定，请联系管理员编辑 .env 文件。'
      );
    }
  }

  async handleStart(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);

      await ctx.reply(
        `👋 欢迎使用 Claude Code Telegram Bot！\n\n` +
        `当前会话: ${session.name}\n` +
        `工作目录: ${session.cwd}\n\n` +
        `可用命令:\n` +
        `/cd <path> - 切换工作目录\n` +
        `/clear - 清空对话历史\n` +
        `/compact - 压缩上下文\n` +
        `/rewind - 撤销最后一轮对话\n` +
        `/plan <msg> - Plan 模式\n` +
        `/stop - 停止当前任务\n` +
        `/status - 查看当前状态\n` +
        `/sessions - 管理多会话\n` +
        `/help - 显示帮助信息\n\n` +
        `直接发送消息即可与 Claude Code 对话。`
      );
    });
  }

  async handleHelp(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      await ctx.reply(
        `🤖 Claude Code Telegram Bot 帮助\n\n` +
        `<b>基本命令</b>\n` +
        `/start - 显示欢迎信息\n` +
        `/cd &lt;path&gt; - 切换工作目录\n` +
        `/clear - 清空对话历史，开始新会话\n` +
        `/compact - 压缩当前会话上下文\n` +
        `/rewind - 撤销最后一轮对话\n` +
        `/plan &lt;msg&gt; - Plan 模式（只规划不执行）\n` +
        `/stop - 停止当前正在执行的任务\n` +
        `/status - 查看当前状态\n` +
        `/help - 显示此帮助信息\n\n` +
        `<b>会话管理</b>\n` +
        `/sessions - 列出所有会话\n` +
        `/sessions new &lt;name&gt; - 创建新会话\n` +
        `/sessions switch &lt;name&gt; - 切换会话\n` +
        `/sessions rename &lt;old&gt; &lt;new&gt; - 重命名\n` +
        `/sessions delete &lt;name&gt; - 删除会话\n` +
        `/sessions info [name] - 查看会话详情\n` +
        `/sessions history [name] [count] - 查看消息记录\n` +
        `/sessions send &lt;name&gt; &lt;message&gt; - 向后台会话发消息\n\n` +
        `<b>使用方法</b>\n` +
        `• 直接发送消息与 Claude Code 对话\n` +
        `• Claude 会自动执行需要的工具（读取文件、运行命令等）\n` +
        `• 对话会保持上下文，可以连续提问\n` +
        `• 使用 /clear 开始新话题\n` +
        `• 使用 /sessions 管理多个独立会话\n\n` +
        `<b>示例</b>\n` +
        `"列出当前目录的所有文件"\n` +
        `"读取 README.md 文件"\n` +
        `"这个项目是做什么的？"`,
        { parse_mode: 'HTML' }
      );
    });
  }

  async handleStatus(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);
      const sessions = this.stateManager.getSessions(userId);

      await ctx.reply(
        `📊 当前状态\n\n` +
        `当前会话: <code>${escapeHtml(session.name)}</code>\n` +
        `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
        `Claude 会话: ${session.claudeSessionId ? `<code>${escapeHtml(session.claudeSessionId.slice(0, 8))}...</code>` : '(新会话)'}\n` +
        `消息记录: ${session.messageHistory.length} 条\n` +
        `会话总数: ${sessions.length}\n` +
        `活跃用户数: ${this.stateManager.getActiveCount()}`,
        { parse_mode: 'HTML' }
      );
    });
  }

  async handleClear(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);
      this.stateManager.clearSessionClaudeId(userId, session.id);

      await ctx.reply(`✅ 会话 "${session.name}" 的对话历史已清空，下次对话将开启新会话。`);
    });
  }

  async handleCompact(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const chatId = ctx.chat!.id;
      const session = this.stateManager.getActiveSession(userId);

      if (!session.claudeSessionId) {
        await ctx.reply('❌ 当前会话没有活跃的 Claude 上下文，无需压缩。');
        return;
      }

      const progressMsg = await ctx.reply(`🗜️ [${session.name}] 正在压缩上下文...`);

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

        let info = `✅ [${session.name}] 上下文已压缩`;
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
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);

      const result = this.stateManager.rewindSession(userId, session.id);
      if (!result.success) {
        await ctx.reply(`❌ ${result.reason}`);
        return;
      }

      await ctx.reply(
        `✅ [${session.name}] 已撤销最后一轮对话\n` +
        `本地记录已回退，Claude 上下文将从上一轮继续。`
      );
    });
  }

  async handlePlan(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);

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

      // 设置 plan mode 标记
      this.stateManager.setSessionPlanMode(userId, session.id, true);

      // 使用 messageHandler 发送，但传入 plan permissionMode
      // 委托给 handleText 处理，但需要注入 permissionMode
      // 通过在 session 上标记 planMode，让 handleText 检测到并使用 plan 模式
      // 模拟一个文本消息处理
      await this.messageHandler.handleTextWithMode(ctx, 'plan');
    });
  }

  async handleCd(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);

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
        this.stateManager.setSessionCwd(userId, session.id, resolvedPath);
        await ctx.reply(`✅ 工作目录已切换到: <code>${escapeHtml(resolvedPath)}</code>`, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(`❌ 目录不存在: ${resolvedPath}`);
      }
    });
  }

  async handleStop(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);
      const lockKey = session.claudeSessionId || session.id;
      const wasRunning = this.claudeClient.abort(lockKey);
      await ctx.reply(wasRunning
        ? `⏹ [${session.name}] 正在停止任务...`
        : `ℹ️ [${session.name}] 当前没有正在执行的任务`);
    });
  }

  // ========== 会话管理命令 ==========

  async handleSessions(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const text = (ctx.message as any)?.text || '';
      // 解析: /sessions [subcommand] [args...]
      const parts = text.split(/\s+/).slice(1);

      // 无参数时显示按钮面板
      if (parts.length === 0) {
        return this.sessionPanel.showMainPanel(ctx, userId);
      }

      const subcommand = parts[0].toLowerCase();

      switch (subcommand) {
        case 'list':
          await this.sessionsListCmd(ctx, userId);
          break;
        case 'new':
          await this.sessionsNewCmd(ctx, userId, parts.slice(1));
          break;
        case 'switch':
          await this.sessionsSwitchCmd(ctx, userId, parts.slice(1));
          break;
        case 'rename':
          await this.sessionsRenameCmd(ctx, userId, parts.slice(1));
          break;
        case 'delete':
          await this.sessionsDeleteCmd(ctx, userId, parts.slice(1));
          break;
        case 'info':
          await this.sessionsInfoCmd(ctx, userId, parts.slice(1));
          break;
        case 'history':
          await this.sessionsHistoryCmd(ctx, userId, parts.slice(1));
          break;
        case 'send':
          await this.sessionsSendCmd(ctx, userId, parts.slice(1));
          break;
        default:
          await ctx.reply(
            `❌ 未知子命令: ${subcommand}\n\n` +
            `可用子命令: list, new, switch, rename, delete, info, history, send`
          );
      }
    });
  }

  private async sessionsListCmd(ctx: Context, userId: number): Promise<void> {
    const sessions = this.stateManager.getSessions(userId);
    const state = this.stateManager.get(userId);

    const lines = sessions.map(s => {
      const marker = s.id === state.activeSessionId ? '▶ ' : '  ';
      const claude = s.claudeSessionId ? '🔗' : '🆕';
      const lastMsg = s.lastMessage
        ? `\n    最近: ${s.lastMessage.slice(0, 60)}${s.lastMessage.length > 60 ? '...' : ''}`
        : '';
      return `${marker}${claude} <b>${escapeHtml(s.name)}</b> (${s.messageHistory.length} 条消息)${lastMsg}`;
    });

    await ctx.reply(
      `📋 会话列表 (${sessions.length})\n\n${lines.join('\n\n')}`,
      { parse_mode: 'HTML' }
    );
  }

  private async sessionsNewCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    const name = args[0];
    if (!name) {
      await ctx.reply('用法: /sessions new <name>');
      return;
    }

    const existing = this.stateManager.getSessionByName(userId, name);
    if (existing) {
      await ctx.reply(`❌ 会话 "${name}" 已存在`);
      return;
    }

    const session = this.stateManager.createSession(userId, name);
    await ctx.reply(
      `✅ 已创建会话 "${escapeHtml(name)}"\n` +
      `工作目录: <code>${escapeHtml(session.cwd)}</code>\n\n` +
      `使用 /sessions switch ${escapeHtml(name)} 切换到该会话`,
      { parse_mode: 'HTML' }
    );
  }

  private async sessionsSwitchCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    const name = args[0];
    if (!name) {
      await ctx.reply('用法: /sessions switch <name>');
      return;
    }

    const session = this.stateManager.getSessionByName(userId, name);
    if (!session) {
      await ctx.reply(`❌ 会话 "${name}" 不存在`);
      return;
    }

    this.stateManager.switchSession(userId, session.id);

    let info = `✅ 已切换到会话 "${escapeHtml(name)}"\n工作目录: <code>${escapeHtml(session.cwd)}</code>`;
    if (session.lastMessage) {
      info += `\n\n最近消息:\n${escapeHtml(session.lastMessage.slice(0, 200))}`;
    }
    await ctx.reply(info, { parse_mode: 'HTML' });
  }

  private async sessionsRenameCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    if (args.length < 2) {
      await ctx.reply('用法: /sessions rename <old> <new>');
      return;
    }

    const [oldName, newName] = args;
    const session = this.stateManager.getSessionByName(userId, oldName);
    if (!session) {
      await ctx.reply(`❌ 会话 "${oldName}" 不存在`);
      return;
    }

    const conflict = this.stateManager.getSessionByName(userId, newName);
    if (conflict) {
      await ctx.reply(`❌ 会话 "${newName}" 已存在`);
      return;
    }

    this.stateManager.renameSession(userId, session.id, newName);
    await ctx.reply(`✅ 会话 "${oldName}" 已重命名为 "${newName}"`);
  }

  private async sessionsDeleteCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    const name = args[0];
    if (!name) {
      await ctx.reply('用法: /sessions delete <name>');
      return;
    }

    const session = this.stateManager.getSessionByName(userId, name);
    if (!session) {
      await ctx.reply(`❌ 会话 "${name}" 不存在`);
      return;
    }

    const result = this.stateManager.deleteSession(userId, session.id);
    if (!result.success) {
      await ctx.reply(`❌ ${result.reason}`);
      return;
    }

    await ctx.reply(`✅ 会话 "${name}" 已删除`);
  }

  private async sessionsInfoCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    let session;
    if (args[0]) {
      session = this.stateManager.getSessionByName(userId, args[0]);
      if (!session) {
        await ctx.reply(`❌ 会话 "${args[0]}" 不存在`);
        return;
      }
    } else {
      session = this.stateManager.getActiveSession(userId);
    }

    const state = this.stateManager.get(userId);
    const isActive = session.id === state.activeSessionId;
    const created = new Date(session.createdAt).toLocaleString('zh-CN');
    const lastMsgTime = session.lastMessageAt
      ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
      : '无';

    await ctx.reply(
      `📄 会话详情: ${escapeHtml(session.name)} ${isActive ? '(当前)' : ''}\n\n` +
      `ID: <code>${escapeHtml(session.id.slice(0, 8))}...</code>\n` +
      `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
      `Claude 会话: ${session.claudeSessionId ? `<code>${escapeHtml(session.claudeSessionId.slice(0, 8))}...</code>` : '(新会话)'}\n` +
      `创建时间: ${created}\n` +
      `最近活动: ${lastMsgTime}\n` +
      `消息记录: ${session.messageHistory.length} 条`,
      { parse_mode: 'HTML' }
    );
  }

  private async sessionsHistoryCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    let session;
    let count = 5;

    // 解析参数: [name] [count]
    if (args.length >= 2) {
      session = this.stateManager.getSessionByName(userId, args[0]);
      if (!session) {
        await ctx.reply(`❌ 会话 "${args[0]}" 不存在`);
        return;
      }
      count = parseInt(args[1]) || 5;
    } else if (args.length === 1) {
      // 可能是 name 或 count
      const parsed = parseInt(args[0]);
      if (!isNaN(parsed)) {
        session = this.stateManager.getActiveSession(userId);
        count = parsed;
      } else {
        session = this.stateManager.getSessionByName(userId, args[0]);
        if (!session) {
          await ctx.reply(`❌ 会话 "${args[0]}" 不存在`);
          return;
        }
      }
    } else {
      session = this.stateManager.getActiveSession(userId);
    }

    count = Math.min(Math.max(count, 1), 20);
    const history = session.messageHistory.slice(-count);

    if (history.length === 0) {
      await ctx.reply(`📜 会话 "${session.name}" 暂无消息记录`);
      return;
    }

    const lines = history.map(m => {
      const role = m.role === 'user' ? '👤' : '🤖';
      const time = new Date(m.timestamp).toLocaleTimeString('zh-CN');
      const text = m.text.slice(0, 200) + (m.text.length > 200 ? '...' : '');
      return `${role} [${time}]\n${text}`;
    });

    await ctx.reply(
      `📜 ${session.name} 最近 ${history.length} 条消息:\n\n${lines.join('\n\n')}`
    );
  }

  private async sessionsSendCmd(ctx: Context, userId: number, args: string[]): Promise<void> {
    if (args.length < 2) {
      await ctx.reply('用法: /sessions send <name> <message>');
      return;
    }

    const name = args[0];
    const message = args.slice(1).join(' ');

    const session = this.stateManager.getSessionByName(userId, name);
    if (!session) {
      await ctx.reply(`❌ 会话 "${name}" 不存在`);
      return;
    }

    await ctx.reply(`⏳ 正在向会话 "${name}" 发送消息（后台执行）...`);

    try {
      const response = await this.messageHandler.handleBackgroundChat(userId, session.id, message);
      await sendLongMessage(ctx, `✅ [${name}] 执行完成:\n\n${response.result}`);
    } catch (error: any) {
      await ctx.reply(`❌ [${name}] 执行失败: ${error.message}`);
    }
  }

}
