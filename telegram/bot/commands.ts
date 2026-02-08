/**
 * Telegram Bot 命令处理器
 */

import { Context } from 'telegraf';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateManager } from './state.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import { resolve } from 'path';
import { timingSafeEqual } from 'crypto';
import { updateAuthorizedChatId, getAuthorizedChatId } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

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

  private checkAuth(ctx: Context): boolean {
    if (!ctx.from || !ctx.chat) return false;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    const authorizedChatId = getAuthorizedChatId();

    if (authorizedChatId) {
      if (chatId === authorizedChatId) {
        this.stateManager.setAuthorized(userId, true);
        return true;
      }
      return false;
    }

    return this.stateManager.isAuthorized(userId);
  }

  private async requireAuth(ctx: Context, handler: () => Promise<void>): Promise<void> {
    if (!ctx.from || !ctx.chat || !this.checkAuth(ctx)) {
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
        `当前绑定的 Chat ID: ${currentChatId}\n` +
        `您的 Chat ID: ${chatId}\n\n` +
        `如需解绑，请手动编辑 .env 文件清除 AUTHORIZED_CHAT_ID。`
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
        `**基本命令**\n` +
        `/start - 显示欢迎信息\n` +
        `/cd <path> - 切换工作目录\n` +
        `/clear - 清空对话历史，开始新会话\n` +
        `/status - 查看当前状态\n` +
        `/help - 显示此帮助信息\n\n` +
        `**会话管理**\n` +
        `/sessions - 列出所有会话\n` +
        `/sessions new <name> - 创建新会话\n` +
        `/sessions switch <name> - 切换会话\n` +
        `/sessions rename <old> <new> - 重命名\n` +
        `/sessions delete <name> - 删除会话\n` +
        `/sessions info [name] - 查看会话详情\n` +
        `/sessions history [name] [count] - 查看消息记录\n` +
        `/sessions send <name> <message> - 向后台会话发消息\n\n` +
        `**使用方法**\n` +
        `• 直接发送消息与 Claude Code 对话\n` +
        `• Claude 会自动执行需要的工具（读取文件、运行命令等）\n` +
        `• 对话会保持上下文，可以连续提问\n` +
        `• 使用 /clear 开始新话题\n` +
        `• 使用 /sessions 管理多个独立会话\n\n` +
        `**示例**\n` +
        `"列出当前目录的所有文件"\n` +
        `"读取 README.md 文件"\n` +
        `"这个项目是做什么的？"`
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
        `当前会话: \`${session.name}\`\n` +
        `工作目录: \`${session.cwd}\`\n` +
        `Claude 会话: ${session.claudeSessionId ? `\`${session.claudeSessionId.slice(0, 8)}...\`` : '(新会话)'}\n` +
        `消息记录: ${session.messageHistory.length} 条\n` +
        `会话总数: ${sessions.length}\n` +
        `活跃用户数: ${this.stateManager.getActiveCount()}`,
        { parse_mode: 'Markdown' }
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

  async handleCd(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const session = this.stateManager.getActiveSession(userId);

      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);

      if (args.length === 0) {
        await ctx.reply(`当前工作目录: \`${session.cwd}\``, { parse_mode: 'Markdown' });
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
        await ctx.reply(`✅ 工作目录已切换到: \`${resolvedPath}\``, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(`❌ 目录不存在: ${resolvedPath}`);
      }
    });
  }

  // ========== 会话管理命令 ==========

  async handleSessions(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const text = (ctx.message as any)?.text || '';
      // 解析: /sessions [subcommand] [args...]
      const parts = text.split(/\s+/).slice(1);
      const subcommand = parts[0]?.toLowerCase() || 'list';

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
      return `${marker}${claude} **${s.name}** (${s.messageHistory.length} 条消息)${lastMsg}`;
    });

    await ctx.reply(
      `📋 会话列表 (${sessions.length})\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' }
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
      `✅ 已创建会话 "${name}"\n` +
      `工作目录: \`${session.cwd}\`\n\n` +
      `使用 /sessions switch ${name} 切换到该会话`,
      { parse_mode: 'Markdown' }
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

    let info = `✅ 已切换到会话 "${name}"\n工作目录: \`${session.cwd}\``;
    if (session.lastMessage) {
      info += `\n\n最近消息:\n${session.lastMessage.slice(0, 200)}`;
    }
    await ctx.reply(info, { parse_mode: 'Markdown' });
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
      `📄 会话详情: ${session.name} ${isActive ? '(当前)' : ''}\n\n` +
      `ID: \`${session.id.slice(0, 8)}...\`\n` +
      `工作目录: \`${session.cwd}\`\n` +
      `Claude 会话: ${session.claudeSessionId ? `\`${session.claudeSessionId.slice(0, 8)}...\`` : '(新会话)'}\n` +
      `创建时间: ${created}\n` +
      `最近活动: ${lastMsgTime}\n` +
      `消息记录: ${session.messageHistory.length} 条`,
      { parse_mode: 'Markdown' }
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
      await this.sendResult(ctx, `✅ [${name}] 执行完成:\n\n${response.result}`);
    } catch (error: any) {
      await ctx.reply(`❌ [${name}] 执行失败: ${error.message}`);
    }
  }

  private async sendResult(ctx: Context, text: string): Promise<void> {
    if (text.length > 4000) {
      const tmpFile = join(tmpdir(), `claude-${Date.now()}.md`);
      try {
        writeFileSync(tmpFile, text, 'utf-8');
        await ctx.replyWithDocument(
          { source: tmpFile, filename: 'response.md' },
          { caption: text.slice(0, 1000) + (text.length > 1000 ? '...' : '') }
        );
      } finally {
        try { unlinkSync(tmpFile); } catch {}
      }
      return;
    }
    await ctx.reply(text);
  }
}
