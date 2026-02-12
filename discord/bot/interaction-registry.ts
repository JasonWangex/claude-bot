/**
 * Discord Interaction Registry
 * Promise-based bridge between Discord component interactions (Buttons/SelectMenus/Modals)
 * and the Claude executor.
 *
 * 支持:
 * - AskUserQuestion → Buttons / StringSelectMenu
 * - ExitPlanMode → Buttons (approve/reject/compact)
 * - Model Switch → StringSelectMenu
 * - 自定义文本输入 → Modal
 */

import { logger } from '../utils/logger.js';

interface PendingEntry {
  toolUseId: string;
  guildId: string;
  threadId: string;
  options?: string[];   // 选项标签列表
  resolve: (value: string) => void;
  createdAt: number;
  waitingCustomText?: boolean;
  noTimeout?: boolean;  // true = 必须等用户显式操作，不自动超时
}

export class InteractionRegistry {
  private pending = new Map<string, PendingEntry>();
  private readonly TTL = 5 * 60 * 1000; // 5 分钟过期

  /**
   * 注册一个等待中的交互
   * @returns customId 前缀，用于匹配 Button/SelectMenu 的 customId
   */
  register(
    toolUseId: string,
    guildId: string,
    threadId: string,
    options?: string[],
    opts?: { noTimeout?: boolean },
  ): { promise: Promise<string>; customIdPrefix: string } {
    // 使用 toolUseId 的前 12 字符作为 customId 前缀
    const customIdPrefix = toolUseId.slice(0, 12);

    const promise = new Promise<string>((resolve) => {
      const entry: PendingEntry = {
        toolUseId,
        guildId,
        threadId,
        options,
        resolve,
        createdAt: Date.now(),
        noTimeout: opts?.noTimeout,
      };
      this.pending.set(toolUseId, entry);

      // Plan 等交互必须等用户显式操作，不设超时
      if (!opts?.noTimeout) {
        setTimeout(() => {
          if (this.pending.has(toolUseId)) {
            entry.resolve('__timeout__');
            this.pending.delete(toolUseId);
            logger.warn(`Interaction timeout: ${toolUseId.slice(0, 12)}`);
          }
        }, this.TTL);
      }
    });

    return { promise, customIdPrefix };
  }

  /**
   * 通过 customId 前缀查找 entry
   */
  findByPrefix(prefix: string): PendingEntry | undefined {
    for (const entry of this.pending.values()) {
      if (entry.toolUseId.startsWith(prefix)) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * 解析交互结果
   */
  resolve(toolUseId: string, value: string): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    entry.resolve(value);
    this.pending.delete(toolUseId);
    return true;
  }

  /**
   * 获取选项标签
   */
  getOptionLabel(toolUseId: string, index: number): string | undefined {
    const entry = this.pending.get(toolUseId);
    return entry?.options?.[index];
  }

  /**
   * 标记为等待自定义文本输入（Modal）
   */
  setWaitingCustomText(toolUseId: string, waiting: boolean): void {
    const entry = this.pending.get(toolUseId);
    if (entry) entry.waitingCustomText = waiting;
  }

  /**
   * 查找特定 thread 中等待自定义文本的 entry
   */
  findWaitingCustomText(guildId: string, threadId: string): PendingEntry | undefined {
    for (const entry of this.pending.values()) {
      if (entry.guildId === guildId && entry.threadId === threadId && entry.waitingCustomText) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * 清理过期条目
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending.entries()) {
      if (!entry.noTimeout && now - entry.createdAt > this.TTL) {
        entry.resolve('__timeout__');
        this.pending.delete(key);
      }
    }
  }
}
