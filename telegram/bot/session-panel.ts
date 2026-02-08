/**
 * Telegram Bot 会话管理面板
 * 使用 Inline Keyboard 按钮交互替代纯文本子命令
 */

import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { StateManager } from './state.js';
import { ClaudeClient } from '../claude/client.js';
import { escapeHtml } from './message-utils.js';
import { StreamEvent } from '../types/index.js';
import { logger } from '../utils/logger.js';

// 面板文本输入等待
interface PendingTextInput {
  chatId: number;
  type: 'session_new' | 'session_rename';
  sessionId?: string;   // rename 时需要
  messageId: number;    // 面板消息 ID，用于后续编辑
  resolve: (text: string) => void;
  createdAt: number;
}

export class SessionPanel {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;
  private pendingTextInputs: Map<number, PendingTextInput> = new Map(); // chatId -> pending

  constructor(stateManager: StateManager, claudeClient: ClaudeClient) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
  }

  // ===== 面板渲染 =====

  /**
   * 主列表面板：/sessions 触发，发送新消息
   */
  async showMainPanel(ctx: Context, userId: number): Promise<void> {
    const { text, keyboard } = this.buildMainPanel(userId);
    try {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      await ctx.reply(text, keyboard);
    }
  }

  /**
   * 主列表面板：原地更新已有消息
   */
  private async editMainPanel(ctx: Context, userId: number): Promise<void> {
    const { text, keyboard } = this.buildMainPanel(userId);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      try {
        await ctx.editMessageText(text, keyboard);
      } catch {
        // fallback: 发新消息
        await this.showMainPanel(ctx, userId);
      }
    }
  }

  private buildMainPanel(userId: number): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
    const sessions = this.stateManager.getSessions(userId);
    const state = this.stateManager.get(userId);

    const lines = sessions.map(s => {
      const marker = s.id === state.activeSessionId ? '▶ ' : '   ';
      const claude = s.claudeSessionId ? '🔗' : '🆕';
      const lastMsg = s.lastMessage
        ? `\n      <i>${escapeHtml(s.lastMessage.slice(0, 50))}${s.lastMessage.length > 50 ? '...' : ''}</i>`
        : '';
      return `${marker}${claude} <b>${escapeHtml(s.name)}</b> (${s.messageHistory.length} 条)${lastMsg}`;
    });

    const text = `📋 <b>会话管理</b> (${sessions.length} 个会话)\n\n${lines.join('\n\n')}`;

    // 按钮：每行最多3个会话按钮
    const sessionButtons: ReturnType<typeof Markup.button.callback>[] = sessions.map(s => {
      const label = s.id === state.activeSessionId ? `${s.name} ✓` : s.name;
      return Markup.button.callback(label.slice(0, 20), `sess:open:${s.id.slice(0, 8)}`);
    });

    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < sessionButtons.length; i += 3) {
      rows.push(sessionButtons.slice(i, i + 3));
    }
    rows.push([
      Markup.button.callback('➕ 新建会话', 'sess:new'),
      Markup.button.callback('🔄 刷新', 'sess:refresh'),
    ]);

    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  /**
   * 单个会话操作面板
   */
  private async editSessionPanel(ctx: Context, userId: number, sessionId: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionId);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    const state = this.stateManager.get(userId);
    const isActive = session.id === state.activeSessionId;
    const created = new Date(session.createdAt).toLocaleString('zh-CN');
    const lastMsgTime = session.lastMessageAt
      ? new Date(session.lastMessageAt).toLocaleString('zh-CN')
      : '无';
    const sid = session.id.slice(0, 8);

    const text =
      `📄 <b>会话: ${escapeHtml(session.name)}</b>${isActive ? ' (当前)' : ''}\n\n` +
      `工作目录: <code>${escapeHtml(session.cwd)}</code>\n` +
      `Claude 上下文: ${session.claudeSessionId ? `已连接 (<code>${escapeHtml(session.claudeSessionId.slice(0, 8))}...</code>)` : '新会话'}\n` +
      `消息记录: ${session.messageHistory.length} 条\n` +
      `创建时间: ${created}\n` +
      `最近活动: ${lastMsgTime}`;

    const rows: ReturnType<typeof Markup.button.callback>[][] = [];

    if (!isActive) {
      rows.push([Markup.button.callback('✅ 切换到此会话', `sess:sw:${sid}`)]);
    }

    rows.push([
      Markup.button.callback('📜 历史', `sess:hist:${sid}`),
      Markup.button.callback('🗜️ 压缩', `sess:compact:${sid}`),
      Markup.button.callback('↩️ 撤销', `sess:rewind:${sid}`),
    ]);

    rows.push([
      Markup.button.callback('✏️ 重命名', `sess:rename:${sid}`),
      Markup.button.callback('🗑️ 删除', `sess:del:${sid}`),
      Markup.button.callback('🧹 清空', `sess:clear:${sid}`),
    ]);

    rows.push([Markup.button.callback('⬅️ 返回列表', 'sess:back')]);

    const keyboard = Markup.inlineKeyboard(rows);

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      try {
        await ctx.editMessageText(text, keyboard);
      } catch {}
    }
  }

  /**
   * 删除确认面板
   */
  private async editDeleteConfirm(ctx: Context, userId: number, sessionId: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionId);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    const sid = session.id.slice(0, 8);
    const text =
      `⚠️ <b>确认删除会话 "${escapeHtml(session.name)}"？</b>\n\n` +
      `此操作不可恢复，会话中的 ${session.messageHistory.length} 条消息记录将被清除。`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('❌ 取消', `sess:open:${sid}`),
        Markup.button.callback('🗑️ 确认删除', `sess:delok:${sid}`),
      ],
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      try { await ctx.editMessageText(text, keyboard); } catch {}
    }
  }

  /**
   * 历史记录面板
   */
  private async editHistoryPanel(ctx: Context, userId: number, sessionId: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionId);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    const sid = session.id.slice(0, 8);
    const history = session.messageHistory.slice(-8);

    let text: string;
    if (history.length === 0) {
      text = `📜 <b>${escapeHtml(session.name)}</b> 暂无消息记录`;
    } else {
      const lines = history.map(m => {
        const role = m.role === 'user' ? '👤' : '🤖';
        const time = new Date(m.timestamp).toLocaleTimeString('zh-CN');
        const msgText = m.text.slice(0, 150) + (m.text.length > 150 ? '...' : '');
        return `${role} [${time}]\n${escapeHtml(msgText)}`;
      });
      text = `📜 <b>${escapeHtml(session.name)}</b> 最近 ${history.length} 条消息:\n\n${lines.join('\n\n')}`;
    }

    // 截断防止超过 Telegram 消息长度限制
    if (text.length > 4000) {
      text = text.slice(0, 3950) + '\n\n<i>... 已截断</i>';
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 返回', `sess:open:${sid}`)],
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      try { await ctx.editMessageText(text, keyboard); } catch {}
    }
  }

  // ===== 回调路由 =====

  async handleCallback(ctx: Context, action: string, param: string): Promise<void> {
    if (!ctx.from || !ctx.chat) return;
    const userId = ctx.from.id;

    switch (action) {
      case 'open':
        await ctx.answerCbQuery().catch(() => {});
        await this.editSessionPanel(ctx, userId, param);
        break;

      case 'sw':
        await this.handleSwitch(ctx, userId, param);
        break;

      case 'del':
        await ctx.answerCbQuery().catch(() => {});
        await this.editDeleteConfirm(ctx, userId, param);
        break;

      case 'delok':
        await this.handleDelete(ctx, userId, param);
        break;

      case 'clear':
        await this.handleClear(ctx, userId, param);
        break;

      case 'compact':
        await this.handleCompact(ctx, userId, param);
        break;

      case 'rewind':
        await this.handleRewind(ctx, userId, param);
        break;

      case 'hist':
        await ctx.answerCbQuery().catch(() => {});
        await this.editHistoryPanel(ctx, userId, param);
        break;

      case 'new':
        await this.handleNewSession(ctx, userId);
        break;

      case 'rename':
        await this.handleRenameSession(ctx, userId, param);
        break;

      case 'back':
        await ctx.answerCbQuery().catch(() => {});
        await this.editMainPanel(ctx, userId);
        break;

      case 'refresh':
        await ctx.answerCbQuery('已刷新').catch(() => {});
        await this.editMainPanel(ctx, userId);
        break;

      default:
        await ctx.answerCbQuery('❌ 未知操作').catch(() => {});
    }
  }

  // ===== 操作处理 =====

  private async handleSwitch(ctx: Context, userId: number, sessionPrefix: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionPrefix);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    this.stateManager.switchSession(userId, session.id);
    await ctx.answerCbQuery(`✅ 已切换到 ${session.name}`).catch(() => {});
    await this.editSessionPanel(ctx, userId, sessionPrefix);
  }

  private async handleDelete(ctx: Context, userId: number, sessionPrefix: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionPrefix);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    const result = this.stateManager.deleteSession(userId, session.id);
    if (!result.success) {
      await ctx.answerCbQuery(`❌ ${result.reason}`).catch(() => {});
      return;
    }

    await ctx.answerCbQuery(`✅ 已删除 ${session.name}`).catch(() => {});
    await this.editMainPanel(ctx, userId);
  }

  private async handleClear(ctx: Context, userId: number, sessionPrefix: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionPrefix);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    this.stateManager.clearSessionClaudeId(userId, session.id);
    await ctx.answerCbQuery(`✅ ${session.name} 已清空上下文`).catch(() => {});
    await this.editSessionPanel(ctx, userId, sessionPrefix);
  }

  private async handleCompact(ctx: Context, userId: number, sessionPrefix: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionPrefix);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    if (!session.claudeSessionId) {
      await ctx.answerCbQuery('❌ 没有活跃上下文，无需压缩').catch(() => {});
      return;
    }

    await ctx.answerCbQuery('🗜️ 正在压缩...').catch(() => {});

    // 临时更新面板消息显示压缩中
    const sid = session.id.slice(0, 8);
    try {
      await ctx.editMessageText(`🗜️ <b>${escapeHtml(session.name)}</b> 正在压缩上下文...`, { parse_mode: 'HTML' });
    } catch {}

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

      let info = `✅ <b>${escapeHtml(session.name)}</b> 上下文已压缩`;
      if (preTokens) {
        info += `\n压缩前: ${Math.round(preTokens / 1000)}K tokens`;
        if (postTokens) {
          info += ` → 压缩后: ${Math.round(postTokens / 1000)}K tokens`;
        }
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ 返回', `sess:open:${sid}`)],
      ]);
      try {
        await ctx.editMessageText(info, { parse_mode: 'HTML', ...keyboard });
      } catch {}
    } catch (error: any) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ 返回', `sess:open:${sid}`)],
      ]);
      try {
        await ctx.editMessageText(`❌ 压缩失败: ${escapeHtml(error.message)}`, { parse_mode: 'HTML', ...keyboard });
      } catch {}
    }
  }

  private async handleRewind(ctx: Context, userId: number, sessionPrefix: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionPrefix);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    const result = this.stateManager.rewindSession(userId, session.id);
    if (!result.success) {
      await ctx.answerCbQuery(`❌ ${result.reason}`).catch(() => {});
      return;
    }

    await ctx.answerCbQuery(`✅ ${session.name} 已撤销`).catch(() => {});
    await this.editSessionPanel(ctx, userId, sessionPrefix);
  }

  private async handleNewSession(ctx: Context, userId: number): Promise<void> {
    await ctx.answerCbQuery().catch(() => {});

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ 取消', 'sess:back')],
    ]);

    try {
      await ctx.editMessageText('✏️ 请输入新会话名称:', { ...keyboard });
    } catch {}

    // 等待用户文本输入
    try {
      const name = await this.waitForTextInput(ctx.chat!.id, 'session_new', (ctx as any).callbackQuery?.message?.message_id);

      if (!name.trim()) {
        await this.editMainPanel(ctx, userId);
        return;
      }

      const existing = this.stateManager.getSessionByName(userId, name.trim());
      if (existing) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ 返回列表', 'sess:back')],
        ]);
        try {
          await ctx.editMessageText(`❌ 会话 "${escapeHtml(name.trim())}" 已存在`, { parse_mode: 'HTML', ...keyboard });
        } catch {}
        return;
      }

      const session = this.stateManager.createSession(userId, name.trim());
      const sid = session.id.slice(0, 8);
      const keyboard2 = Markup.inlineKeyboard([
        [Markup.button.callback('✅ 切换到新会话', `sess:sw:${sid}`)],
        [Markup.button.callback('⬅️ 返回列表', 'sess:back')],
      ]);
      try {
        await ctx.editMessageText(
          `✅ 已创建会话 "<b>${escapeHtml(name.trim())}</b>"\n工作目录: <code>${escapeHtml(session.cwd)}</code>`,
          { parse_mode: 'HTML', ...keyboard2 }
        );
      } catch {}
    } catch {
      // 超时或取消
      try {
        await this.editMainPanel(ctx, userId);
      } catch {}
    }
  }

  private async handleRenameSession(ctx: Context, userId: number, sessionPrefix: string): Promise<void> {
    const session = this.findSessionByPrefix(userId, sessionPrefix);
    if (!session) {
      await ctx.answerCbQuery('❌ 会话不存在').catch(() => {});
      return;
    }

    await ctx.answerCbQuery().catch(() => {});

    const sid = session.id.slice(0, 8);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ 取消', `sess:open:${sid}`)],
    ]);

    try {
      await ctx.editMessageText(
        `✏️ 请输入新名称（当前: <b>${escapeHtml(session.name)}</b>）:`,
        { parse_mode: 'HTML', ...keyboard }
      );
    } catch {}

    try {
      const newName = await this.waitForTextInput(
        ctx.chat!.id, 'session_rename',
        (ctx as any).callbackQuery?.message?.message_id,
        session.id
      );

      if (!newName.trim()) {
        await this.editSessionPanel(ctx, userId, sessionPrefix);
        return;
      }

      const conflict = this.stateManager.getSessionByName(userId, newName.trim());
      if (conflict) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ 返回', `sess:open:${sid}`)],
        ]);
        try {
          await ctx.editMessageText(`❌ 会话 "${escapeHtml(newName.trim())}" 已存在`, { parse_mode: 'HTML', ...keyboard });
        } catch {}
        return;
      }

      this.stateManager.renameSession(userId, session.id, newName.trim());

      const keyboard2 = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ 返回', `sess:open:${sid}`)],
      ]);
      try {
        await ctx.editMessageText(
          `✅ 已重命名为 "<b>${escapeHtml(newName.trim())}</b>"`,
          { parse_mode: 'HTML', ...keyboard2 }
        );
      } catch {}
    } catch {
      try {
        await this.editSessionPanel(ctx, userId, sessionPrefix);
      } catch {}
    }
  }

  // ===== 文本输入等待机制 =====

  /**
   * 等待用户文本输入，30秒超时
   */
  private waitForTextInput(
    chatId: number,
    type: 'session_new' | 'session_rename',
    messageId?: number,
    sessionId?: string
  ): Promise<string> {
    // 清除同 chat 之前的等待
    const existing = this.pendingTextInputs.get(chatId);
    if (existing) {
      existing.resolve('');
    }

    return new Promise<string>((resolve, reject) => {
      const entry: PendingTextInput = {
        chatId,
        type,
        sessionId,
        messageId: messageId || 0,
        resolve,
        createdAt: Date.now(),
      };
      this.pendingTextInputs.set(chatId, entry);

      // 30 秒超时
      setTimeout(() => {
        if (this.pendingTextInputs.get(chatId) === entry) {
          this.pendingTextInputs.delete(chatId);
          reject(new Error('输入超时'));
        }
      }, 30000);
    });
  }

  /**
   * 供 handleText 调用：检查是否有等待的面板文本输入
   */
  getPendingTextInput(chatId: number): PendingTextInput | null {
    return this.pendingTextInputs.get(chatId) || null;
  }

  /**
   * 解析文本输入
   */
  resolveTextInput(chatId: number, text: string): boolean {
    const entry = this.pendingTextInputs.get(chatId);
    if (!entry) return false;
    this.pendingTextInputs.delete(chatId);
    entry.resolve(text);
    return true;
  }

  // ===== 工具方法 =====

  /**
   * 通过 session ID 前缀查找完整 session
   */
  private findSessionByPrefix(userId: number, prefix: string): ReturnType<StateManager['getSessionById']> {
    const sessions = this.stateManager.getSessions(userId);
    return sessions.find(s => s.id.startsWith(prefix));
  }
}
