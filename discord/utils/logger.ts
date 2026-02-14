/**
 * 全局 Logger — 多 transport 架构（Console + Discord）
 */

import type { Client, TextChannel } from 'discord.js';

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Transport interface
 */
export interface LogTransport {
  log(level: LogLevel, message: string, ...args: any[]): void | Promise<void>;
}

/**
 * Console Transport
 */
export class ConsoleTransport implements LogTransport {
  private prefix: string;

  constructor(prefix: string = 'DC') {
    this.prefix = prefix;
  }

  log(level: LogLevel, message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    const tag = `[${this.prefix}-${level.toUpperCase()}]`;
    const fullMessage = `${tag} ${timestamp} ${message}`;

    switch (level) {
      case 'debug':
        if (process.env.DEBUG) {
          console.log(fullMessage, ...args);
        }
        break;
      case 'info':
        console.log(fullMessage, ...args);
        break;
      case 'warn':
        console.warn(fullMessage, ...args);
        break;
      case 'error':
        console.error(fullMessage, ...args);
        break;
    }
  }
}

/**
 * Discord Transport
 * 发送日志到指定 Discord Channel
 */
export class DiscordTransport implements LogTransport {
  private client: Client | null = null;
  private channelId: string | null = null;
  private minLevel: LogLevel;

  constructor(minLevel: LogLevel = 'warn') {
    this.minLevel = minLevel;
  }

  /**
   * 初始化 Discord client 和 channel
   */
  init(client: Client, channelId: string): void {
    this.client = client;
    this.channelId = channelId;
  }

  /**
   * 检查日志级别是否应该输出
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(level);
    const minIndex = levels.indexOf(this.minLevel);
    return currentIndex >= minIndex;
  }

  async log(level: LogLevel, message: string, ...args: any[]): Promise<void> {
    if (!this.client || !this.channelId) return;
    if (!this.shouldLog(level)) return;

    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (!channel || !channel.isTextBased()) return;

      const timestamp = new Date().toISOString();
      const emoji = this.getLevelEmoji(level);
      const formattedArgs = args.length > 0 ? `\n\`\`\`\n${JSON.stringify(args, null, 2)}\n\`\`\`` : '';
      const content = `${emoji} **[${level.toUpperCase()}]** ${timestamp}\n${message}${formattedArgs}`;

      await (channel as TextChannel).send({ content: content.slice(0, 2000) });
    } catch (err) {
      // 避免递归错误，只在控制台输出
      console.error('[DiscordTransport] Failed to send log:', err);
    }
  }

  private getLevelEmoji(level: LogLevel): string {
    switch (level) {
      case 'debug': return '🔍';
      case 'info': return 'ℹ️';
      case 'warn': return '⚠️';
      case 'error': return '❌';
      default: return '📝';
    }
  }
}

/**
 * Logger class with multiple transports
 */
export class Logger {
  private transports: LogTransport[] = [];

  addTransport(transport: LogTransport): void {
    this.transports.push(transport);
  }

  clearTransports(): void {
    this.transports = [];
  }

  getTransports(): LogTransport[] {
    return [...this.transports];
  }

  private async logToAll(level: LogLevel, message: string, ...args: any[]): Promise<void> {
    const promises = this.transports.map(t => {
      try {
        const result = t.log(level, message, ...args);
        return result instanceof Promise ? result : Promise.resolve();
      } catch (err) {
        console.error(`[Logger] Transport error:`, err);
        return Promise.resolve();
      }
    });
    await Promise.allSettled(promises);
  }

  debug(message: string, ...args: any[]): void {
    this.logToAll('debug', message, ...args).catch(() => {});
  }

  info(message: string, ...args: any[]): void {
    this.logToAll('info', message, ...args).catch(() => {});
  }

  warn(message: string, ...args: any[]): void {
    this.logToAll('warn', message, ...args).catch(() => {});
  }

  error(message: string, ...args: any[]): void {
    this.logToAll('error', message, ...args).catch(() => {});
  }
}

/**
 * 全局默认 logger 实例（仅 Console）
 * 在 Bot 启动后会通过 createLogger 初始化带 Discord transport 的 logger
 */
export const logger = createLogger();

/**
 * 工厂方法：创建 Logger 实例
 * @param options.prefix - Console transport 前缀，默认 'DC'
 * @param options.discordClient - Discord client 实例（可选）
 * @param options.discordChannelId - Discord channel ID（可选）
 * @param options.discordMinLevel - Discord transport 最低日志级别，默认 'warn'
 */
export function createLogger(options?: {
  prefix?: string;
  discordClient?: Client;
  discordChannelId?: string;
  discordMinLevel?: LogLevel;
}): Logger {
  const logger = new Logger();

  // 始终添加 Console transport
  const consoleTransport = new ConsoleTransport(options?.prefix || 'DC');
  logger.addTransport(consoleTransport);

  // 如果提供了 Discord 配置，添加 Discord transport
  if (options?.discordClient && options?.discordChannelId) {
    const discordTransport = new DiscordTransport(options.discordMinLevel || 'warn');
    discordTransport.init(options.discordClient, options.discordChannelId);
    logger.addTransport(discordTransport);
  }

  return logger;
}
