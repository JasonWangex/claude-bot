/**
 * File Transport — 将日志持久化写入文件
 *
 * - 所有级别日志追加写入同一文件
 * - error 级别自动附加 stack trace
 * - 支持通过 LOG_FILE 环境变量指定文件路径，默认 logs/discord.log
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { LoggerTransport, LogEntry } from '../logger.js';

export class FileTransport implements LoggerTransport {
  private filePath: string;
  private debugEnabled: boolean;

  constructor(filePath: string, debugEnabled = false) {
    this.filePath = filePath;
    this.debugEnabled = debugEnabled;
    // 确保日志目录存在，失败时降级到 stderr 警告而不是崩溃进程
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch (err) {
      process.stderr.write(`[FileTransport] Cannot create log dir: ${err}\n`);
    }
  }

  log(entry: LogEntry): void {
    if (entry.level === 'debug' && !this.debugEnabled) {
      return;
    }

    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);

    // 格式化额外参数
    // 若 entry.stack 存在，Error 对象的 message 已在 stack 第一行，跳过避免重复
    let argsStr = '';
    if (entry.args.length > 0) {
      const parts = entry.args
        .map((arg) => {
          if (arg instanceof Error) {
            return entry.stack ? null : arg.message;
          }
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        })
        .filter((s) => s !== null);
      if (parts.length > 0) argsStr = ' ' + parts.join(' ');
    }

    let line = `[${level}] ${timestamp} ${entry.message}${argsStr}\n`;

    // error 级别附加完整 stack trace
    if (entry.stack) {
      line += `${entry.stack}\n`;
    }

    try {
      appendFileSync(this.filePath, line, 'utf8');
    } catch (err) {
      // 写文件失败时回退到 stderr，避免丢失日志
      process.stderr.write(`[FileTransport] Failed to write log: ${err}\n`);
    }
  }
}
