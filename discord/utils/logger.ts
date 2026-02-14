/**
 * 全局 Logger — 多 Transport 架构（Console + Discord）
 */

import { ConsoleTransport } from './transports/console-transport.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  args: any[];
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
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      args,
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
// 默认只包含 Console Transport，Discord Transport 需要在 Bot 初始化后配置
export const logger = createLogger({ transports: [new ConsoleTransport(!!process.env.DEBUG)] });
