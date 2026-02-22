/**
 * 全局 Logger — 多 Transport 架构（Console + Discord + File）
 */

import { ConsoleTransport } from './transports/console-transport.js';
import { FileTransport } from './transports/file-transport.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  args: any[];
  /** Error 对象的完整堆栈信息（仅 error 级别时填充） */
  stack?: string;
}

/**
 * Logger Transport 接口
 */
export interface LoggerTransport {
  log(entry: LogEntry): void;
}

/**
 * Logger 类
 */
export class Logger {
  private transports: LoggerTransport[] = [];

  addTransport(transport: LoggerTransport): void {
    this.transports.push(transport);
  }

  private log(level: LogLevel, message: string, ...args: any[]): void {
    // 对 error 级别，自动从 args 中提取 Error 对象的堆栈
    let stack: string | undefined;
    if (level === 'error') {
      for (const arg of args) {
        if (arg instanceof Error && arg.stack) {
          stack = arg.stack;
          break;
        }
      }
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      args,
      stack,
    };

    for (const transport of this.transports) {
      try {
        transport.log(entry);
      } catch (error) {
        console.error(`[Logger] Transport error:`, error);
      }
    }
  }

  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args);
  }
}

/**
 * createLogger 工厂方法
 */
export interface CreateLoggerOptions {
  transports?: LoggerTransport[];
}

export function createLogger(options?: CreateLoggerOptions): Logger {
  const logger = new Logger();

  if (options?.transports) {
    for (const transport of options.transports) {
      logger.addTransport(transport);
    }
  }

  return logger;
}

// 全局默认 logger 实例（向后兼容）
// 默认包含 Console Transport 和 File Transport，Discord Transport 需要在 Bot 初始化后配置
const logFilePath = process.env.LOG_FILE || 'logs/discord.log';
export const logger = createLogger({
  transports: [
    new ConsoleTransport(!!process.env.DEBUG),
    new FileTransport(logFilePath, !!process.env.DEBUG),
  ],
});
