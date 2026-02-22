/**
 * Console Transport — 将日志输出到控制台
 */

import type { LoggerTransport, LogEntry } from '../logger.js';

export class ConsoleTransport implements LoggerTransport {
  private debugEnabled: boolean;

  constructor(debugEnabled = false) {
    this.debugEnabled = debugEnabled;
  }

  log(entry: LogEntry): void {
    // 如果是 debug 且未启用，则跳过
    if (entry.level === 'debug' && !this.debugEnabled) {
      return;
    }

    const prefix = `[DC-${entry.level.toUpperCase()}]`;
    const timestamp = entry.timestamp.toISOString();
    const message = `${prefix} ${timestamp} ${entry.message}`;

    switch (entry.level) {
      case 'error': {
        // 将 Error 对象替换为 err.message，避免 Node.js 自动序列化 Error 导致堆栈重复输出
        const displayArgs = entry.args.map((a) => (a instanceof Error ? a.message : a));
        console.error(message, ...displayArgs);
        if (entry.stack) {
          console.error(entry.stack);
        }
        break;
      }
      case 'warn':
        console.warn(message, ...entry.args);
        break;
      case 'debug':
      case 'info':
      default:
        console.log(message, ...entry.args);
        break;
    }
  }
}
