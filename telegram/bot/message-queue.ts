/**
 * Telegram 消息队列：生产者-消费者模型
 * 解耦 Claude 输出与 Telegram API 调用，统一 rate limiting 和错误处理
 *
 * Per-Topic 节流：普通消息在 TopicBuffer 中缓冲 15 秒后合并发送，
 * 高优先级消息和每个 topic 的第一条消息立即发送。
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
    entities?: any[];     // Telegram MessageEntity[]（与 parseMode 互斥）
    replyMarkup?: any;
    silent?: boolean;  // false = 发出通知；默认 true（静默）
    priority?: 'high' | 'normal';  // high: 立即发送；normal（默认）: 走缓冲区
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

// --- TopicBuffer ---

interface BufferedSend {
  text: string;           // 原始纯文本（合并用）
  resolve: (messageId: number) => void;
  reject: (error: Error) => void;
}

interface TopicBuffer {
  pendingTexts: BufferedSend[];
  timer: NodeJS.Timeout | null;
  firstSent: boolean;     // 本轮对话是否已发送过第一条消息
  chatId: number;
  topicId: number;
}

// --- MessageQueue ---

export class MessageQueue {
  private queue: TelegramOp[] = [];
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private pendingAsyncOps = 0;  // 追踪 sendLong+recreateProgress 等悬空 Promise
  private telegram: Telegram;
  private last429NotifyTime = 0;  // 429 通知防抖时间戳

  // Per-topic 缓冲区
  private topicBuffers = new Map<string, TopicBuffer>();

  // 配置
  private readonly FLUSH_INTERVAL = 100;   // 100ms flush 一次
  private readonly MIN_OP_INTERVAL = 35;   // 操作间最小间隔 35ms
  private readonly MAX_RETRY = 2;          // 429 重试次数
  private readonly TOPIC_BUFFER_WINDOW = 15000;  // 15s 缓冲窗口
  private readonly RATE_LIMIT_NOTIFY_COOLDOWN = 60000;  // 429 通知冷却 60s
  private readonly MERGE_SEPARATOR = '\n\n───\n\n';
  private readonly MAX_MERGE_LENGTH = 2000;      // 单条合并消息上限

  constructor(telegram: Telegram) {
    this.telegram = telegram;
  }

  private topicKey(chatId: number, topicId?: number): string {
    return `${chatId}:${topicId ?? 0}`;
  }

  // --- 生产者 API ---

  /**
   * 发送消息，返回 messageId
   * priority: 'high' → 立即发送（flush 缓冲区后入队）
   * priority: 'normal'（默认）→ 进缓冲区，15 秒后合并发送
   */
  send(chatId: number, topicId: number | undefined, text: string, options?: {
    parseMode?: 'HTML' | 'Markdown';
    entities?: any[];
    replyMarkup?: any;
    silent?: boolean;
    priority?: 'high' | 'normal';
  }): Promise<number> {
    const priority = options?.priority || 'normal';
    const key = this.topicKey(chatId, topicId);
    const buffer = this.topicBuffers.get(key);

    // 高优先级、带特殊格式（entities/replyMarkup/parseMode）、或第一条消息 → 立即发送
    const isFirst = !buffer?.firstSent;
    const hasSpecialFormat = !!(options?.entities?.length || options?.replyMarkup || options?.parseMode);
    if (priority === 'high' || isFirst || hasSpecialFormat) {
      // 先 flush 缓冲区
      this.flushTopicBuffer(key);
      // 标记 firstSent
      this.ensureBuffer(chatId, topicId).firstSent = true;
      // 直接入队
      return new Promise((resolve, reject) => {
        this.queue.push({ type: 'send', chatId, topicId, text, options, resolve, reject });
      });
    }

    // 普通消息 → 进缓冲区
    return this.bufferSend(chatId, topicId, text);
  }

  /**
   * 发送文档附件，返回 messageId（不受缓冲区控制）
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
    priority?: 'high' | 'normal';
  }): Promise<number> {
    if (text.length > 4000) {
      const caption = text.slice(0, 1000);
      return this.sendDocument(chatId, topicId, text, 'response.md', caption, { silent: options?.silent });
    }

    const priority = options?.priority || 'normal';
    const key = this.topicKey(chatId, topicId);
    const buffer = this.topicBuffers.get(key);

    // 高优先级、带 replyMarkup、或第一条消息 → 立即发送（走 HTML 转换）
    const isFirst = !buffer?.firstSent;
    if (priority === 'high' || isFirst || options?.replyMarkup) {
      this.flushTopicBuffer(key);
      this.ensureBuffer(chatId, topicId).firstSent = true;

      const html = markdownToHtml(text);
      return new Promise((resolve, reject) => {
        this.queue.push({
          type: 'send', chatId, topicId,
          text: html,
          originalText: text,
          options: { parseMode: 'HTML', replyMarkup: options?.replyMarkup, silent: options?.silent },
          resolve, reject,
        });
      });
    }

    // 普通消息 → 进缓冲区（存原始文本，flush 时再转 HTML）
    return this.bufferSend(chatId, topicId, text);
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

  // --- Topic 缓冲区管理 ---

  /**
   * 重置 topic 节流状态（每轮对话开始时调用）
   */
  resetTopicState(chatId: number, topicId?: number): void {
    const key = this.topicKey(chatId, topicId);
    const buffer = this.topicBuffers.get(key);
    if (buffer) {
      // flush 残留缓冲
      this.flushTopicBuffer(key);
      buffer.firstSent = false;
    }
  }

  /**
   * flush 所有 topic 缓冲区
   */
  flushAllTopicBuffers(): void {
    for (const key of this.topicBuffers.keys()) {
      this.flushTopicBuffer(key);
    }
  }

  private ensureBuffer(chatId: number, topicId?: number): TopicBuffer {
    const key = this.topicKey(chatId, topicId);
    let buffer = this.topicBuffers.get(key);
    if (!buffer) {
      buffer = { pendingTexts: [], timer: null, firstSent: false, chatId, topicId: topicId ?? 0 };
      this.topicBuffers.set(key, buffer);
    }
    return buffer;
  }

  /**
   * 将普通消息放入 topic 缓冲区
   */
  private bufferSend(chatId: number, topicId: number | undefined, text: string): Promise<number> {
    const buffer = this.ensureBuffer(chatId, topicId);
    return new Promise((resolve, reject) => {
      buffer.pendingTexts.push({ text, resolve, reject });

      // 重置定时器
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = setTimeout(() => {
        this.flushTopicBuffer(this.topicKey(chatId, topicId));
      }, this.TOPIC_BUFFER_WINDOW);
    });
  }

  /**
   * flush 指定 topic 的缓冲区：合并文本后入队发送
   */
  private flushTopicBuffer(key: string): void {
    const buffer = this.topicBuffers.get(key);
    if (!buffer || buffer.pendingTexts.length === 0) return;

    // 清除定时器
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    const pending = buffer.pendingTexts.splice(0);
    const { chatId, topicId } = buffer;
    const effectiveTopicId = topicId === 0 ? undefined : topicId;

    // 分批合并，尊重 MAX_MERGE_LENGTH
    const batches: BufferedSend[][] = [];
    let currentBatch: BufferedSend[] = [];
    let currentLength = 0;

    for (const item of pending) {
      const addLength = currentLength === 0
        ? item.text.length
        : this.MERGE_SEPARATOR.length + item.text.length;

      if (currentLength + addLength > this.MAX_MERGE_LENGTH && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [item];
        currentLength = item.text.length;
      } else {
        currentBatch.push(item);
        currentLength += addLength;
      }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    // 每批合并为一条消息入队
    for (const batch of batches) {
      const mergedText = batch.map(b => b.text).join(this.MERGE_SEPARATOR);
      const html = markdownToHtml(mergedText);

      this.queue.push({
        type: 'send',
        chatId,
        topicId: effectiveTopicId,
        text: html,
        originalText: mergedText,
        options: { parseMode: 'HTML', silent: true },
        resolve: (messageId: number) => {
          for (const item of batch) item.resolve(messageId);
        },
        reject: (error: Error) => {
          for (const item of batch) item.reject(error);
        },
      });
    }
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
   * 先 flush 所有 topic 缓冲区，再排空底层队列
   */
  async drain(timeoutMs = 30000): Promise<void> {
    // 先 flush 所有 topic buffer，使缓冲消息进入队列
    this.flushAllTopicBuffers();

    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.processing || this.pendingAsyncOps > 0) && Date.now() < deadline) {
      // stop() 后 timer 已清除，需要主动驱动消费
      if (this.queue.length > 0 && !this.processing) {
        await this.flush();
      }
      await new Promise(r => setTimeout(r, 50));
    }

    // 防御性清理：确保所有 topic buffer 定时器已清除
    for (const [, buffer] of this.topicBuffers) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
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
    // entities 与 parse_mode 互斥
    const useEntities = op.options?.entities && op.options.entities.length > 0;
    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        const msg = await this.telegram.sendMessage(op.chatId, op.text, {
          ...(useEntities
            ? { entities: op.options!.entities }
            : { parse_mode: op.options?.parseMode }),
          reply_markup: op.options?.replyMarkup,
          message_thread_id: op.topicId,
          disable_notification: disableNotification,
        });
        op.resolve(msg.message_id);
        return;
      } catch (error: any) {
        if (this.is429(error) && attempt < this.MAX_RETRY) {
          await this.backoff429(error, op.chatId);
          continue;
        }
        // entities 或 HTML 解析失败 → 用纯文本重发
        if (this.is400(error) && (useEntities || (op.options?.parseMode === 'HTML' && op.originalText))) {
          try {
            const fallbackText = op.originalText || op.text;
            const msg = await this.telegram.sendMessage(op.chatId, fallbackText, {
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
            await this.backoff429(error, op.chatId);
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
          await this.backoff429(error, op.chatId);
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
          await this.backoff429(error, op.chatId);
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

  private async backoff429(error: any, chatId?: number): Promise<void> {
    const retryAfter = error?.response?.parameters?.retry_after || 1;
    const delayMs = retryAfter * 1000;
    logger.warn(`MessageQueue 429 rate limited, backing off ${retryAfter}s`);

    // 向 General topic 发送防抖通知
    const now = Date.now();
    if (chatId && now - this.last429NotifyTime > this.RATE_LIMIT_NOTIFY_COOLDOWN) {
      this.last429NotifyTime = now;
      this.telegram.sendMessage(
        chatId,
        `⚠️ Telegram API rate limited, backing off ${retryAfter}s`,
        { disable_notification: true },
      ).catch(() => {});  // 通知本身失败不影响主流程
    }

    await this.sleep(delayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
