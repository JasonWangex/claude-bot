/**
 * Telegram 消息队列：生产者-消费者模型
 * 解耦 Claude 输出与 Telegram API 调用，统一 rate limiting 和错误处理
 */

import { Telegram } from 'telegraf';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { markdownToHtml } from './message-utils.js';
import { logger } from '../utils/logger.js';

// --- 操作类型 ---

interface SendOp {
  type: 'send';
  chatId: number;
  topicId?: number;
  text: string;
  originalText?: string;  // HTML 回退用：保存原始纯文本
  options?: {
    parseMode?: 'HTML' | 'Markdown';
    replyMarkup?: any;
    silent?: boolean;  // false = 发出通知；默认 true（静默）
  };
  resolve: (messageId: number) => void;
  reject: (error: Error) => void;
}

interface SendDocumentOp {
  type: 'sendDocument';
  chatId: number;
  topicId?: number;
  content: string;
  filename: string;
  caption?: string;
  silent?: boolean;  // false = 发出通知；默认 true（静默）
  resolve: (messageId: number) => void;
  reject: (error: Error) => void;
}

interface EditOp {
  type: 'edit';
  chatId: number;
  messageId: number;
  text: string;
  options?: {
    parseMode?: 'HTML';
    replyMarkup?: any;
  };
}

interface DeleteOp {
  type: 'delete';
  chatId: number;
  messageId: number;
}

type TelegramOp = SendOp | SendDocumentOp | EditOp | DeleteOp;

// --- MessageQueue ---

export class MessageQueue {
  private queue: TelegramOp[] = [];
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private pendingAsyncOps = 0;  // 追踪 sendLong+recreateProgress 等悬空 Promise
  private telegram: Telegram;

  // 配置
  private readonly FLUSH_INTERVAL = 100;   // 100ms flush 一次
  private readonly MIN_OP_INTERVAL = 35;   // 操作间最小间隔 35ms
  private readonly MAX_RETRY = 2;          // 429 重试次数

  constructor(telegram: Telegram) {
    this.telegram = telegram;
  }

  // --- 生产者 API ---

  /**
   * 发送消息，返回 messageId
   */
  send(chatId: number, topicId: number | undefined, text: string, options?: {
    parseMode?: 'HTML' | 'Markdown';
    replyMarkup?: any;
    silent?: boolean;
  }): Promise<number> {
    return new Promise((resolve, reject) => {
      this.queue.push({ type: 'send', chatId, topicId, text, options, resolve, reject });
    });
  }

  /**
   * 发送文档附件，返回 messageId
   */
  sendDocument(chatId: number, topicId: number | undefined, content: string, filename: string, caption?: string, options?: { silent?: boolean }): Promise<number> {
    return new Promise((resolve, reject) => {
      this.queue.push({ type: 'sendDocument', chatId, topicId, content, filename, caption, silent: options?.silent, resolve, reject });
    });
  }

  /**
   * 发送长消息：>4000 字符自动转为文件附件，否则 markdown → HTML
   * HTML 回退在消费者层面处理，不会二次入队破坏顺序
   */
  sendLong(chatId: number, topicId: number | undefined, text: string, options?: {
    replyMarkup?: any;
    silent?: boolean;
  }): Promise<number> {
    if (text.length > 4000) {
      const caption = text.slice(0, 1000);
      return this.sendDocument(chatId, topicId, text, 'response.md', caption, { silent: options?.silent });
    }

    const html = markdownToHtml(text);
    return new Promise((resolve, reject) => {
      this.queue.push({
        type: 'send', chatId, topicId,
        text: html,
        originalText: text,  // 保存原始文本用于 HTML 回退
        options: { parseMode: 'HTML', replyMarkup: options?.replyMarkup, silent: options?.silent },
        resolve, reject,
      });
    });
  }

  /**
   * 编辑消息（fire-and-forget）
   */
  edit(chatId: number, messageId: number, text: string, options?: {
    parseMode?: 'HTML';
    replyMarkup?: any;
  }): void {
    this.queue.push({ type: 'edit', chatId, messageId, text, options });
  }

  /**
   * 删除消息（fire-and-forget）
   */
  delete(chatId: number, messageId: number): void {
    this.queue.push({ type: 'delete', chatId, messageId });
  }

  /**
   * 包装异步操作，使 drain 能感知悬空 Promise
   */
  trackAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingAsyncOps++;
    return fn().finally(() => { this.pendingAsyncOps--; });
  }

  // --- 生命周期 ---

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.FLUSH_INTERVAL);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 排空队列，等待所有操作完成（含悬空 Promise）
   */
  async drain(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.processing || this.pendingAsyncOps > 0) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // --- 消费者 ---

  private async flush(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    try {
      // 取出当前所有操作并做 edit 合并
      const ops = this.mergeEdits(this.queue.splice(0));

      for (const op of ops) {
        await this.executeOp(op);
        await this.sleep(this.MIN_OP_INTERVAL);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Edit 合并：连续的、针对同一 messageId 的 edit 只保留最后一个
   */
  private mergeEdits(ops: TelegramOp[]): TelegramOp[] {
    const result: TelegramOp[] = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type !== 'edit') {
        result.push(op);
        continue;
      }

      // 向前看：如果后续紧跟同一 messageId 的 edit，跳过当前
      let j = i + 1;
      while (j < ops.length && ops[j].type === 'edit' &&
             (ops[j] as EditOp).chatId === op.chatId &&
             (ops[j] as EditOp).messageId === op.messageId) {
        j++;
      }
      // 只保留最后一个 edit
      result.push(ops[j - 1]);
      i = j - 1;
    }

    return result;
  }

  private async executeOp(op: TelegramOp): Promise<void> {
    switch (op.type) {
      case 'send':
        await this.executeSend(op);
        break;
      case 'sendDocument':
        await this.executeSendDocument(op);
        break;
      case 'edit':
        await this.executeEdit(op);
        break;
      case 'delete':
        await this.executeDelete(op);
        break;
    }
  }

  private async executeSend(op: SendOp): Promise<void> {
    const disableNotification = op.options?.silent !== false;  // 默认静默
    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        const msg = await this.telegram.sendMessage(op.chatId, op.text, {
          parse_mode: op.options?.parseMode,
          reply_markup: op.options?.replyMarkup,
          message_thread_id: op.topicId,
          disable_notification: disableNotification,
        });
        op.resolve(msg.message_id);
        return;
      } catch (error: any) {
        if (this.is429(error) && attempt < this.MAX_RETRY) {
          await this.backoff429(error);
          continue;
        }
        // HTML 解析失败 → 用原始纯文本重发（同一次执行，不重新入队）
        if (this.is400(error) && op.options?.parseMode === 'HTML' && op.originalText) {
          try {
            const msg = await this.telegram.sendMessage(op.chatId, op.originalText, {
              reply_markup: op.options?.replyMarkup,
              message_thread_id: op.topicId,
              disable_notification: disableNotification,
            });
            op.resolve(msg.message_id);
            return;
          } catch (fallbackError: any) {
            logger.error('MessageQueue send fallback failed:', fallbackError.message);
            op.reject(fallbackError);
            return;
          }
        }
        logger.error('MessageQueue send failed:', error.message);
        op.reject(error);
        return;
      }
    }
  }

  private async executeSendDocument(op: SendDocumentOp): Promise<void> {
    const disableNotification = op.silent !== false;  // 默认静默
    const tmpFile = join(tmpdir(), `claude-mq-${Date.now()}-${op.filename}`);
    try {
      writeFileSync(tmpFile, op.content, 'utf-8');
      for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
        try {
          const msg = await this.telegram.sendDocument(op.chatId,
            { source: tmpFile, filename: op.filename },
            {
              caption: op.caption,
              message_thread_id: op.topicId,
              disable_notification: disableNotification,
            },
          );
          op.resolve(msg.message_id);
          return;
        } catch (error: any) {
          if (this.is429(error) && attempt < this.MAX_RETRY) {
            await this.backoff429(error);
            continue;
          }
          logger.error('MessageQueue sendDocument failed:', error.message);
          op.reject(error);
          return;
        }
      }
      // 防御性兜底：循环穷尽（理论上 429 分支的 continue 最终会到 reject）
      op.reject(new Error('sendDocument: all retries exhausted'));
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  private async executeEdit(op: EditOp): Promise<void> {
    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        await this.telegram.editMessageText(op.chatId, op.messageId, undefined, op.text, {
          parse_mode: op.options?.parseMode,
          reply_markup: op.options?.replyMarkup,
        });
        return;
      } catch (error: any) {
        if (this.is429(error) && attempt < this.MAX_RETRY) {
          await this.backoff429(error);
          continue;
        }
        // 400: message not modified / message not found → 静默
        if (this.is400(error)) {
          logger.debug('MessageQueue edit skipped (400):', error.message);
          return;
        }
        if (this.is403(error)) {
          logger.warn('MessageQueue edit forbidden:', error.message);
          return;
        }
        logger.debug('MessageQueue edit failed:', error.message);
        return;
      }
    }
  }

  private async executeDelete(op: DeleteOp): Promise<void> {
    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        await this.telegram.deleteMessage(op.chatId, op.messageId);
        return;
      } catch (error: any) {
        if (this.is429(error) && attempt < this.MAX_RETRY) {
          await this.backoff429(error);
          continue;
        }
        // 静默处理
        logger.debug('MessageQueue delete failed:', error.message);
        return;
      }
    }
  }

  // --- 错误处理工具 ---

  private is429(error: any): boolean {
    return error?.response?.error_code === 429 ||
           error?.code === 429 ||
           (typeof error?.message === 'string' && error.message.includes('429'));
  }

  private is400(error: any): boolean {
    return error?.response?.error_code === 400 || error?.code === 400;
  }

  private is403(error: any): boolean {
    return error?.response?.error_code === 403 || error?.code === 403;
  }

  private async backoff429(error: any): Promise<void> {
    const retryAfter = error?.response?.parameters?.retry_after || 1;
    const delayMs = retryAfter * 1000;
    logger.warn(`MessageQueue 429 rate limited, backing off ${retryAfter}s`);
    await this.sleep(delayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
