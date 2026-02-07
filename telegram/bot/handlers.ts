/**
 * Telegram Bot 消息处理器
 */

import { Context } from 'telegraf';
import { StateManager } from './state.js';
import { ClaudeClient } from '../claude/client.js';
import { StreamEvent } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { splitMessage, addChunkMarker } from '../utils/formatter.js';
import { getAuthorizedChatId } from '../utils/env.js';

// 工具名称映射
const TOOL_NAMES: Record<string, string> = {
  Read: '读取文件',
  Write: '写入文件',
  Edit: '编辑文件',
  Glob: '搜索文件',
  Grep: '搜索内容',
  Bash: '执行命令',
  WebFetch: '获取网页',
  WebSearch: '搜索网络',
  Task: '启动子任务',
  NotebookEdit: '编辑笔记本',
};

export class MessageHandler {
  private stateManager: StateManager;
  private claudeClient: ClaudeClient;

  constructor(stateManager: StateManager, claudeClient: ClaudeClient) {
    this.stateManager = stateManager;
    this.claudeClient = claudeClient;
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

  async handleText(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const text = (ctx.message as any)?.text;

    if (!text) return;
    if (text.startsWith('/')) return;

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

    const state = this.stateManager.get(userId);
    logger.user(userId, 'Message:', text.substring(0, 100));

    // 发送初始进度消息
    const progressMsg = await ctx.reply('⏳ 思考中...');
    const chatId = ctx.chat!.id;
    const progressMsgId = progressMsg.message_id;

    // 进度状态
    let lastProgressText = '⏳ 思考中...';
    let toolUseCount = 0;
    let lastEditTime = Date.now();

    // 进度回调：实时更新 Telegram 消息
    const onProgress = (event: StreamEvent) => {
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use' && block.name) {
            toolUseCount++;
            const toolLabel = TOOL_NAMES[block.name] || block.name;

            // 构造简短摘要
            let detail = '';
            if (block.input) {
              if (block.name === 'Read' && block.input.file_path) {
                detail = `: ${this.shortPath(block.input.file_path)}`;
              } else if (block.name === 'Bash' && block.input.command) {
                detail = `: ${block.input.command.slice(0, 40)}`;
              } else if (block.name === 'Grep' && block.input.pattern) {
                detail = `: ${block.input.pattern}`;
              } else if (block.name === 'Glob' && block.input.pattern) {
                detail = `: ${block.input.pattern}`;
              } else if ((block.name === 'Edit' || block.name === 'Write') && block.input.file_path) {
                detail = `: ${this.shortPath(block.input.file_path)}`;
              }
            }

            const newText = `🔧 [${toolUseCount}] ${toolLabel}${detail}`;

            // 限制编辑频率（至少 1 秒间隔）
            const now = Date.now();
            if (newText !== lastProgressText && now - lastEditTime >= 1000) {
              lastProgressText = newText;
              lastEditTime = now;
              ctx.telegram.editMessageText(chatId, progressMsgId, undefined, newText)
                .catch(() => {}); // 忽略编辑失败
            }
          }
        }
      }
    };

    try {
      const response = await this.claudeClient.chat(text, {
        sessionId: state.sessionId,
        cwd: state.cwd,
      }, onProgress);

      this.stateManager.setSessionId(userId, response.sessionId);
      logger.user(userId, 'Response length:', response.result.length);

      // 删除进度消息
      await ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});

      // 发送最终结果
      await this.sendLongMessage(ctx, response.result);

    } catch (error: any) {
      logger.error(`User ${userId} error:`, error.message);

      // 编辑进度消息为错误信息
      await ctx.telegram.editMessageText(
        chatId, progressMsgId, undefined,
        `❌ 发生错误:\n${error.message}\n\n提示: 使用 /clear 清空会话`
      ).catch(() => {});
    }
  }

  private shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : filePath;
  }

  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    const chunks = splitMessage(text, 4000);

    for (let i = 0; i < chunks.length; i++) {
      const content = addChunkMarker(chunks[i], i, chunks.length);

      try {
        await ctx.reply(content, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.debug('Markdown parsing failed, using plain text');
        await ctx.reply(content, { parse_mode: undefined });
      }

      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
}
