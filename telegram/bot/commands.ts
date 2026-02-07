/**
 * Telegram Bot 命令处理器
 */

import { Context } from 'telegraf';
import { StateManager } from './state.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { updateAuthorizedChatId, getAuthorizedChatId } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

export class CommandHandler {
  private stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  private getAccessToken(): string {
    return process.env.BOT_ACCESS_TOKEN || '';
  }

  private checkAuth(ctx: Context): boolean {
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;

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
    if (!this.checkAuth(ctx)) {
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
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const text = (ctx.message as any)?.text || '';
    const args = text.split(/\s+/).slice(1);

    if (args.length === 0) {
      await ctx.reply('请提供访问令牌: /login <token>');
      return;
    }

    const token = args[0];
    const accessToken = this.getAccessToken();

    if (token !== accessToken) {
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
      const state = this.stateManager.get(userId);

      await ctx.reply(
        `👋 欢迎使用 Claude Code Telegram Bot！\n\n` +
        `当前工作目录: ${state.cwd}\n\n` +
        `可用命令:\n` +
        `/cd <path> - 切换工作目录\n` +
        `/clear - 清空对话历史\n` +
        `/status - 查看当前状态\n` +
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
        `/status - 查看当前状态（工作目录、会话ID）\n` +
        `/help - 显示此帮助信息\n\n` +
        `**使用方法**\n` +
        `• 直接发送消息与 Claude Code 对话\n` +
        `• Claude 会自动执行需要的工具（读取文件、运行命令等）\n` +
        `• 对话会保持上下文，可以连续提问\n` +
        `• 使用 /clear 开始新话题\n\n` +
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
      const state = this.stateManager.get(userId);

      await ctx.reply(
        `📊 当前状态\n\n` +
        `工作目录: \`${state.cwd}\`\n` +
        `会话 ID: ${state.sessionId || '(新会话)'}\n` +
        `活跃用户数: ${this.stateManager.getActiveCount()}`,
        { parse_mode: 'Markdown' }
      );
    });
  }

  async handleClear(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      this.stateManager.clearSession(userId);

      await ctx.reply('✅ 对话历史已清空，下次对话将开启新会话。');
    });
  }

  async handleCd(ctx: Context): Promise<void> {
    await this.requireAuth(ctx, async () => {
      const userId = ctx.from!.id;
      const state = this.stateManager.get(userId);

      const text = (ctx.message as any)?.text || '';
      const args = text.split(/\s+/).slice(1);

      if (args.length === 0) {
        await ctx.reply(`当前工作目录: \`${state.cwd}\``, { parse_mode: 'Markdown' });
        return;
      }

      const newCwd = args[0];

      try {
        const { stdout } = await execAsync(`cd "${newCwd.replace(/"/g, '\\"')}" && pwd`, {
          timeout: 5000,
        });

        const resolvedPath = stdout.trim();
        this.stateManager.setCwd(userId, resolvedPath);

        await ctx.reply(`✅ 工作目录已切换到: \`${resolvedPath}\``, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await ctx.reply(`❌ 无效的目录: ${newCwd}\n\n错误: ${error.message}`);
      }
    });
  }
}
