/**
 * Discord 消息队列：生产者-消费者模型
 * 解耦 Claude 输出与 Discord API 调用，统一 rate limiting 和错误处理
 *
 * Per-Thread 节流：普通消息在 ThreadBuffer 中缓冲 3 秒后合并发送，
 * 高优先级消息和每个 thread 的第一条消息立即发送。
 *
 * 消息长度策略：
 * - < 2000 字符: 普通消息（原生 Markdown）
 * - 2000~4096 字符: Embed（description 支持 4096 字符）
 * - > 4096 字符: 文件附件（.md 文件）
 */

import {
  type Client,
  type TextBasedChannel,
  type Message,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
  type ActionRowBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { isOssEnabled, uploadToOss } from '../utils/oss.js';

// --- Embed 颜色常量 ---

export const EmbedColors = {
  GRAY: 0x99AAB5,     // 进度状态 (info)
  GREEN: 0x57F287,    // 成功/完成
  RED: 0xED4245,      // 错误
  YELLOW: 0xFEE75C,   // 警告
  PURPLE: 0x9B59B6,   // 系统/API 来源消息
  BLUE: 0x3498DB,     // Pipeline 阶段变化
} as const;

export type EmbedColor = typeof EmbedColors[keyof typeof EmbedColors] | number;

// --- 操作类型 ---

interface SendOp {
  type: 'send';
  channelId: string;
  text: string;
  options?: {
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    silent?: boolean;  // 抑制 @everyone 提及 (suppressNotifications)
    priority?: 'high' | 'normal';
    embedColor?: EmbedColor;  // 设置后以 Embed 格式发送
  };
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
}

interface SendDocumentOp {
  type: 'sendDocument';
  channelId: string;
  content: string;
  filename: string;
  caption?: string;
  silent?: boolean;
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
}

interface EditOp {
  type: 'edit';
  channelId: string;
  messageId: string;
  text: string;
  options?: {
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    embedColor?: EmbedColor;  // 设置后以 Embed 格式编辑
  };
}

interface DeleteOp {
  type: 'delete';
  channelId: string;
  messageId: string;
}

type DiscordOp = SendOp | SendDocumentOp | EditOp | DeleteOp;

// --- ThreadBuffer ---

interface BufferedSend {
  text: string;
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
}

interface ThreadBuffer {
  pendingTexts: BufferedSend[];
  timer: NodeJS.Timeout | null;
  firstSent: boolean;
  channelId: string;
}

// --- MessageQueue ---

export class MessageQueue {
  private queue: DiscordOp[] = [];
  private timer: NodeJS.Timeout | null = null;
  private pendingAsyncOps = 0;
  private activeDispatches = 0;
  private client: Client;
  private channelCache = new Map<string, TextBasedChannel>();

  // Per-thread 缓冲区
  private threadBuffers = new Map<string, ThreadBuffer>();

  // 配置（Discord global rate limit: 50 req/s，目标 45 op/s）
  private readonly FLUSH_INTERVAL = 20;
  private readonly DISPATCH_INTERVAL = 22;   // ~45 op/s（1000ms / 45 ≈ 22ms/op）
  private readonly MAX_RETRY = 2;

  // Promise 链式调度器：串行分配时间槽，各 op 并发执行
  private rateLimiterChain: Promise<void> = Promise.resolve();
  private lastDispatchAt = 0;
  private readonly THREAD_BUFFER_WINDOW = 1000;   // 1s 缓冲窗口
  private readonly MERGE_SEPARATOR = '\n\n───\n\n';
  private readonly MAX_MERGE_LENGTH = 1800;        // Discord 2000 字符限制，留余量
  private readonly MAX_MESSAGE_LENGTH = 2000;
  private readonly MAX_EMBED_LENGTH = 4096;

  constructor(client: Client) {
    this.client = client;
  }

  private async getChannel(channelId: string): Promise<TextBasedChannel | null> {
    const cached = this.channelCache.get(channelId);
    if (cached) return cached;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        this.channelCache.set(channelId, channel as TextBasedChannel);
        return channel as TextBasedChannel;
      }
    } catch (err: any) {
      logger.error(`Failed to fetch channel ${channelId}:`, err);
    }
    return null;
  }

  // --- 生产者 API ---

  /**
   * 获取频道中最后一条消息的 ID（用于将 tool thread 挂载到触发消息上）
   */
  async getLastMessageId(channelId: string): Promise<string | null> {
    const channel = await this.getChannel(channelId);
    if (!channel || !('messages' in channel)) return null;
    try {
      const msgs = await (channel as any).messages.fetch({ limit: 1 });
      return msgs.first()?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 发送消息，返回 messageId
   */
  send(channelId: string, text: string, options?: {
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    silent?: boolean;
    priority?: 'high' | 'normal';
    embedColor?: EmbedColor;
  }): Promise<string> {
    const priority = options?.priority || 'normal';
    const buffer = this.threadBuffers.get(channelId);

    const isFirst = !buffer?.firstSent;
    const hasSpecialFormat = !!(options?.components || options?.embedColor);
    if (priority === 'high' || isFirst || hasSpecialFormat) {
      this.flushThreadBuffer(channelId);
      this.ensureBuffer(channelId).firstSent = true;
      return new Promise((resolve, reject) => {
        this.queue.push({ type: 'send', channelId, text, options, resolve, reject });
      });
    }

    return this.bufferSend(channelId, text);
  }

  /**
   * 发送文档附件，返回 messageId
   */
  sendDocument(channelId: string, content: string, filename: string, caption?: string, options?: { silent?: boolean }): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ type: 'sendDocument', channelId, content, filename, caption, silent: options?.silent, resolve, reject });
    });
  }

  /**
   * 发送 Embed 消息，超过 4096 字符截断
   */
  sendEmbed(channelId: string, text: string, options?: {
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    silent?: boolean;
    color?: EmbedColor;
  }): Promise<string> {
    return this.send(channelId, text.slice(0, this.MAX_EMBED_LENGTH), {
      embedColor: options?.color,
      components: options?.components,
      silent: options?.silent,
    });
  }

  /**
   * 发送长消息：自动选择最佳格式
   * - < 2000: 普通消息（原生 Markdown）
   * - 2000~4096: Embed
   * - > 4096: 文件附件
   */
  sendLong(channelId: string, text: string, options?: {
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    silent?: boolean;
    priority?: 'high' | 'normal';
    embedColor?: EmbedColor;
  }): Promise<string> {
    if (text.length > this.MAX_EMBED_LENGTH) {
      const caption = text.slice(0, 1000);
      return this.sendDocument(channelId, text, 'response.md', caption, { silent: options?.silent });
    }

    if (text.length > this.MAX_MESSAGE_LENGTH) {
      // 使用 Embed（embedColor 有自定义就用，否则默认 Discord Blurple）
      const embedColor = options?.embedColor ?? 0x5865F2;
      return this.send(channelId, text, { ...options, embedColor, priority: 'high' });
    }

    const priority = options?.priority || 'normal';
    const buffer = this.threadBuffers.get(channelId);
    const isFirst = !buffer?.firstSent;
    if (priority === 'high' || isFirst || options?.components) {
      this.flushThreadBuffer(channelId);
      this.ensureBuffer(channelId).firstSent = true;
      return new Promise((resolve, reject) => {
        this.queue.push({ type: 'send', channelId, text, options, resolve, reject });
      });
    }

    return this.bufferSend(channelId, text);
  }

  /**
   * 编辑消息（fire-and-forget）
   */
  edit(channelId: string, messageId: string, text: string, options?: {
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    embedColor?: EmbedColor;
  }): void {
    this.queue.push({ type: 'edit', channelId, messageId, text, options });
  }

  /**
   * 删除消息（fire-and-forget）
   */
  delete(channelId: string, messageId: string): void {
    this.queue.push({ type: 'delete', channelId, messageId });
  }

  /**
   * 包装异步操作，使 drain 能感知悬空 Promise
   */
  trackAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingAsyncOps++;
    return fn().finally(() => { this.pendingAsyncOps--; });
  }

  // --- Thread 缓冲区管理 ---

  resetThreadState(channelId: string): void {
    const buffer = this.threadBuffers.get(channelId);
    if (buffer) {
      this.flushThreadBuffer(channelId);
      buffer.firstSent = false;
    }
  }

  flushAllThreadBuffers(): void {
    for (const key of this.threadBuffers.keys()) {
      this.flushThreadBuffer(key);
    }
  }

  private ensureBuffer(channelId: string): ThreadBuffer {
    let buffer = this.threadBuffers.get(channelId);
    if (!buffer) {
      buffer = { pendingTexts: [], timer: null, firstSent: false, channelId };
      this.threadBuffers.set(channelId, buffer);
    }
    return buffer;
  }

  private bufferSend(channelId: string, text: string): Promise<string> {
    const buffer = this.ensureBuffer(channelId);
    return new Promise((resolve, reject) => {
      buffer.pendingTexts.push({ text, resolve, reject });

      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = setTimeout(() => {
        this.flushThreadBuffer(channelId);
      }, this.THREAD_BUFFER_WINDOW);
    });
  }

  private flushThreadBuffer(channelId: string): void {
    const buffer = this.threadBuffers.get(channelId);
    if (!buffer || buffer.pendingTexts.length === 0) return;

    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    const pending = buffer.pendingTexts.splice(0);

    // 分批合并
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

    for (const batch of batches) {
      const mergedText = batch.map(b => b.text).join(this.MERGE_SEPARATOR);

      this.queue.push({
        type: 'send',
        channelId,
        text: mergedText,
        options: { silent: true },
        resolve: (messageId: string) => {
          for (const item of batch) item.resolve(messageId);
        },
        reject: (error: Error) => {
          for (const item of batch) item.reject(error);
        },
      });
    }
  }

  /**
   * 在指定消息上创建 Discord Thread，返回 thread channel ID
   * 带 retry/backoff，与 executeSend 等操作保持一致
   */
  async finalizeThread(threadId: string, name: string): Promise<void> {
    try {
      await this.acquireSlot();
      const thread = await this.client.channels.fetch(threadId);
      if (!thread || !('setName' in thread)) return;
      await this.acquireSlot();
      await (thread as any).setName(name.slice(0, 100));
      await this.acquireSlot();
      await (thread as any).setArchived(true);
    } catch (err: any) {
      logger.warn(`finalizeThread ${threadId} failed:`, err);
    }
  }

  async createThread(channelId: string, messageId: string, name: string): Promise<string> {
    const channel = await this.getChannel(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    const message = await (channel as any).messages.fetch(messageId);

    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        await this.acquireSlot();
        const thread = await message.startThread({
          name: name.slice(0, 100),
          autoArchiveDuration: 60,
        });
        return thread.id;
      } catch (err: any) {
        if (this.isRateLimit(err) && attempt < this.MAX_RETRY) {
          await this.backoffRateLimit(err);
          continue;
        }
        throw err;
      }
    }
    throw new Error('createThread: all retries exhausted');
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

  async drain(timeoutMs = 30000): Promise<void> {
    this.flushAllThreadBuffers();
    await this.flush();

    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.activeDispatches > 0 || this.pendingAsyncOps > 0) && Date.now() < deadline) {
      if (this.queue.length > 0) await this.flush();
      await new Promise(r => setTimeout(r, 50));
    }

    for (const [, buffer] of this.threadBuffers) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
    }
  }

  // --- 调度器 ---

  /**
   * 获取一个调度时间槽。
   * 内部通过 Promise 链确保各槽之间至少间隔 DISPATCH_INTERVAL ms，
   * 从而将全局吞吐量限制在 ~45 op/s。
   * 各 op 拿到槽后可并发执行，不互相等待。
   */
  private acquireSlot(): Promise<void> {
    const slot = this.rateLimiterChain.then(async () => {
      const wait = this.DISPATCH_INTERVAL - (Date.now() - this.lastDispatchAt);
      if (wait > 0) await this.sleep(wait);
      this.lastDispatchAt = Date.now();
    });
    this.rateLimiterChain = slot;
    return slot;
  }

  // --- 消费者 ---

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const ops = this.mergeEdits(this.queue.splice(0));

    for (const op of ops) {
      await this.acquireSlot();
      this.activeDispatches++;
      void this.executeOp(op)
        .catch(err => logger.error('executeOp unexpected error:', err))
        .finally(() => { this.activeDispatches--; });
    }
  }

  private mergeEdits(ops: DiscordOp[]): DiscordOp[] {
    const result: DiscordOp[] = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type !== 'edit') {
        result.push(op);
        continue;
      }

      let j = i + 1;
      while (j < ops.length && ops[j].type === 'edit' &&
             (ops[j] as EditOp).channelId === op.channelId &&
             (ops[j] as EditOp).messageId === op.messageId) {
        j++;
      }
      result.push(ops[j - 1]);
      i = j - 1;
    }

    return result;
  }

  private async executeOp(op: DiscordOp): Promise<void> {
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
    const channel = await this.getChannel(op.channelId);
    if (!channel || !('send' in channel)) {
      op.reject(new Error(`Channel ${op.channelId} not found or not sendable`));
      return;
    }

    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        // embedColor 参数 → Embed 消息
        const embedColor = op.options?.embedColor;
        if (embedColor !== undefined) {
          const embed = new EmbedBuilder()
            .setDescription(op.text.slice(0, this.MAX_EMBED_LENGTH))
            .setColor(embedColor);
          const msgOpts: MessageCreateOptions = {
            embeds: [embed],
            components: op.options?.components as any,
            ...(op.options?.silent && { flags: MessageFlags.SuppressNotifications }),
          };
          const msg = await (channel as any).send(msgOpts);
          op.resolve(msg.id);
          return;
        }

        // 普通消息
        const msgOpts: MessageCreateOptions = {
          content: op.text.slice(0, this.MAX_MESSAGE_LENGTH),
          components: op.options?.components as any,
          ...(op.options?.silent && { flags: MessageFlags.SuppressNotifications }),
        };
        const msg = await (channel as any).send(msgOpts);
        op.resolve(msg.id);
        return;
      } catch (error: any) {
        if (this.isRateLimit(error) && attempt < this.MAX_RETRY) {
          await this.backoffRateLimit(error);
          continue;
        }
        logger.error('MessageQueue send failed:', error);
        op.reject(error);
        return;
      }
    }
  }

  private async executeSendDocument(op: SendDocumentOp): Promise<void> {
    const channel = await this.getChannel(op.channelId);
    if (!channel || !('send' in channel)) {
      op.reject(new Error(`Channel ${op.channelId} not found or not sendable`));
      return;
    }

    // OSS 上传分支：上传文件并发送签名链接
    if (isOssEnabled()) {
      try {
        const signedUrl = await uploadToOss(op.content, op.filename);
        const link = `[${op.filename}](${signedUrl})`;
        const maxCaptionLen = this.MAX_MESSAGE_LENGTH - link.length - 2;
        const text = op.caption && maxCaptionLen > 0
          ? `${op.caption.slice(0, maxCaptionLen)}\n${link}`
          : link;
        const msgOpts: MessageCreateOptions = {
          content: text,
          ...(op.silent && { flags: MessageFlags.SuppressNotifications }),
        };
        for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
          try {
            const msg = await (channel as any).send(msgOpts);
            op.resolve(msg.id);
            return;
          } catch (sendError: any) {
            if (this.isRateLimit(sendError) && attempt < this.MAX_RETRY) {
              await this.backoffRateLimit(sendError);
              continue;
            }
            throw sendError; // 非 rate limit → 外层 catch → fall through
          }
        }
      } catch (error: any) {
        logger.warn('OSS upload/send failed, falling back to attachment:', error.message);
        // fall through 到原有附件逻辑
      }
    }

    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        const attachment = new AttachmentBuilder(
          Buffer.from(op.content, 'utf-8'),
          { name: op.filename },
        );
        const msgOpts: MessageCreateOptions = {
          content: op.caption?.slice(0, this.MAX_MESSAGE_LENGTH),
          files: [attachment],
          ...(op.silent && { flags: MessageFlags.SuppressNotifications }),
        };
        const msg = await (channel as any).send(msgOpts);
        op.resolve(msg.id);
        return;
      } catch (error: any) {
        if (this.isRateLimit(error) && attempt < this.MAX_RETRY) {
          await this.backoffRateLimit(error);
          continue;
        }
        logger.error('MessageQueue sendDocument failed:', error);
        op.reject(error);
        return;
      }
    }
    op.reject(new Error('sendDocument: all retries exhausted'));
  }

  private async executeEdit(op: EditOp): Promise<void> {
    const channel = await this.getChannel(op.channelId);
    if (!channel) return;

    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        const message = await (channel as any).messages.fetch(op.messageId);
        if (!message) return;

        const embedColor = op.options?.embedColor;
        if (embedColor !== undefined) {
          const embed = new EmbedBuilder()
            .setDescription(op.text.slice(0, this.MAX_EMBED_LENGTH))
            .setColor(embedColor);
          await message.edit({
            content: null,
            embeds: [embed],
            components: op.options?.components as any,
          });
          return;
        }

        await message.edit({
          content: op.text.slice(0, this.MAX_MESSAGE_LENGTH),
          embeds: [],
          components: op.options?.components as any,
        });
        return;
      } catch (error: any) {
        if (this.isRateLimit(error) && attempt < this.MAX_RETRY) {
          await this.backoffRateLimit(error);
          continue;
        }
        logger.debug('MessageQueue edit failed:', error.message);
        return;
      }
    }
  }

  private async executeDelete(op: DeleteOp): Promise<void> {
    const channel = await this.getChannel(op.channelId);
    if (!channel) return;

    for (let attempt = 0; attempt <= this.MAX_RETRY; attempt++) {
      try {
        const message = await (channel as any).messages.fetch(op.messageId);
        if (!message) return;
        await message.delete();
        return;
      } catch (error: any) {
        if (this.isRateLimit(error) && attempt < this.MAX_RETRY) {
          await this.backoffRateLimit(error);
          continue;
        }
        logger.debug('MessageQueue delete failed:', error.message);
        return;
      }
    }
  }

  // --- 错误处理 ---

  private isRateLimit(error: any): boolean {
    return error?.status === 429 ||
           (typeof error?.message === 'string' && error.message.includes('rate limit'));
  }

  private async backoffRateLimit(error: any): Promise<void> {
    const retryAfter = error?.retryAfter || error?.retry_after || 1;
    const delayMs = retryAfter * 1000;
    logger.warn(`MessageQueue rate limited, backing off ${retryAfter}s`);
    await this.sleep(delayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
