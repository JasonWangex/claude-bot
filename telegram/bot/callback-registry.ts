/**
 * Promise-based 回调注册表
 * 桥接 Telegram callback_query/text 输入和 executor 的异步等待
 */

import { logger } from '../utils/logger.js';

interface PendingEntry {
  toolUseId: string;
  chatId: number;
  messageId: number;
  toolName: string;
  optionLabels?: string[];           // AskUserQuestion 选项标签
  waitingCustomText?: boolean;       // 是否等待用户输入自定义文本
  resolve: (answer: string) => void;
  reject: (reason: any) => void;
  createdAt: number;
}

export class CallbackRegistry {
  private pending: Map<string, PendingEntry> = new Map();

  /**
   * 注册一个等待用户输入的 Promise
   * @returns Promise 在用户响应时 resolve
   */
  register(
    toolUseId: string,
    chatId: number,
    messageId: number,
    toolName: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pending.set(toolUseId, {
        toolUseId,
        chatId,
        messageId,
        toolName,
        resolve,
        reject,
        createdAt: Date.now(),
      });
      logger.debug(`CallbackRegistry: registered ${toolName} [${toolUseId.slice(-8)}]`);
    });
  }

  /**
   * 解析对应 Promise，返回给 executor
   */
  resolve(toolUseId: string, answer: string): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    this.pending.delete(toolUseId);
    entry.resolve(answer);
    logger.debug(`CallbackRegistry: resolved [${toolUseId.slice(-8)}]`);
    return true;
  }

  /**
   * 拒绝对应 Promise（用于 CLI 崩溃等场景）
   */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * 从截断的 callback_data 反查完整 toolUseId
   * callback_data 格式: input:<toolUseId后20字符>:<action>
   */
  findByTruncatedId(truncatedId: string): PendingEntry | null {
    for (const [fullId, entry] of this.pending) {
      if (fullId.endsWith(truncatedId) || fullId.slice(-20) === truncatedId) {
        return entry;
      }
    }
    return null;
  }

  /**
   * 查找某个 chat 中等待自定义文本输入的条目
   */
  getPendingCustomText(chatId: number): PendingEntry | null {
    for (const entry of this.pending.values()) {
      if (entry.chatId === chatId && entry.waitingCustomText) {
        return entry;
      }
    }
    return null;
  }

  /**
   * 标记某个条目为等待自定义文本
   */
  setWaitingCustomText(toolUseId: string, waiting: boolean): void {
    const entry = this.pending.get(toolUseId);
    if (entry) {
      entry.waitingCustomText = waiting;
    }
  }

  /**
   * 存储选项标签映射（用于从按钮 index 反查标签文本）
   */
  setOptionMapping(toolUseId: string, labels: string[]): void {
    const entry = this.pending.get(toolUseId);
    if (entry) {
      entry.optionLabels = labels;
    }
  }

  /**
   * 获取选项标签
   */
  getOptionLabel(toolUseId: string, index: number): string | undefined {
    const entry = this.pending.get(toolUseId);
    return entry?.optionLabels?.[index];
  }

  /**
   * 清理过期条目（默认 1 小时）
   */
  cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > maxAgeMs) {
        entry.reject(new Error('交互超时（1小时未响应）'));
        this.pending.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`CallbackRegistry: cleaned ${cleaned} stale entries`);
    }
    return cleaned;
  }

  get size(): number {
    return this.pending.size;
  }
}
