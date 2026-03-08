/**
 * Discord Transport — 将日志发送到 Discord Bot Logs 频道
 */

import type { LoggerTransport, LogEntry } from '../logger.js';
import type { MessageQueue, EmbedColor } from '../../bot/message-queue.js';
import { EmbedColors, MessagePriority } from '../../bot/message-queue.js';

export interface DiscordTransportOptions {
  messageQueue: MessageQueue;
  channelId: string;
  minLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class DiscordTransport implements LoggerTransport {
  private messageQueue: MessageQueue;
  private channelId: string;
  private minLevel: 'debug' | 'info' | 'warn' | 'error';
  private sending = false; // 防重入标志，避免 messageQueue 内部 logger 调用导致循环

  // Level priority mapping
  private static readonly LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(options: DiscordTransportOptions) {
    this.messageQueue = options.messageQueue;
    this.channelId = options.channelId;
    this.minLevel = options.minLevel || 'info';
  }

  log(entry: LogEntry): void {
    // 防重入：messageQueue.send() 内部可能调用 logger，跳过避免循环
    if (this.sending) {
      return;
    }

    // 检查日志级别是否满足最小级别要求
    if (DiscordTransport.LEVEL_PRIORITY[entry.level] < DiscordTransport.LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const embedColor = this.getEmbedColor(entry.level);
    const timestamp = entry.timestamp.toISOString();

    // 格式化消息
    let message = `**[${entry.level.toUpperCase()}]** ${timestamp}\n${entry.message}`;

    // 如果有额外参数，尝试格式化
    // 若 entry.stack 存在，Error 对象的 message 已在 stack 第一行，跳过避免重复
    if (entry.args.length > 0) {
      const argsStr = entry.args
        .map((arg) => {
          if (arg instanceof Error) {
            return entry.stack ? null : arg.message;
          }
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg, null, 2);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        })
        .filter((s) => s !== null)
        .join(' ');

      if (argsStr) {
        message += `\n\`\`\`\n${argsStr}\n\`\`\``;
      }
    }

    // error 级别附加 stack trace
    if (entry.stack) {
      // 截断过长的堆栈，避免超出 Discord 消息限制
      const stackLines = entry.stack.split('\n').slice(0, 10).join('\n');
      message += `\n\`\`\`\n${stackLines}\n\`\`\``;
    }

    // 异步发送，不阻塞日志调用
    this.sending = true;
    this.messageQueue.send(this.channelId, message, {
      embedColor,
      silent: true,
      priority: entry.level === 'error' ? MessagePriority.High : MessagePriority.Normal,
    }).catch(err => {
      console.error('[DiscordTransport] Failed to send log:', err);
    }).finally(() => {
      this.sending = false;
    });
  }

  private getEmbedColor(level: string): EmbedColor {
    switch (level) {
      case 'error':
        return EmbedColors.RED;
      case 'warn':
        return EmbedColors.YELLOW;
      case 'debug':
        return EmbedColors.GRAY;
      case 'info':
      default:
        return EmbedColors.BLUE;
    }
  }
}
