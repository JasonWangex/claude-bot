/**
 * API Error Interceptor
 * 统一处理 Claude 500 服务端错误的自动恢复机制：
 * - 第 N 次失败：等待 20s × N 后向受影响的 channel 发送 "continue"
 * - 最大重试 5 次，超出后停止（不进入紧急模式）
 * - 任意 channel 成功响应后重置该 channel 的计数器
 *
 * 计数器按 channel 独立维护，避免多 channel 并发错误互相干扰。
 */

import { logger } from '../utils/logger.js';

export class ApiErrorInterceptor {
  /** 每个 channel 的连续错误计数，key = `${guildId}:${channelId}` */
  private readonly consecutiveErrors = new Map<string, number>();
  /** 每个 channel 待执行的重试 timer */
  private readonly pendingRetries = new Map<string, NodeJS.Timeout>();

  private static readonly MAX_RETRIES = 5;
  private static readonly BASE_DELAY_MS = 20_000; // 20s × attempt

  constructor(
    /** 重试回调：向指定 channel 发送 "continue" */
    private readonly onRetry: (guildId: string, channelId: string) => void,
  ) {}

  /**
   * 当 API_ERROR 发生时调用。
   * 返回 true 表示已安排重试，调用方应保持任务为 running 状态。
   * 返回 false 表示已超过最大重试次数，调用方应让任务正常失败。
   */
  handleApiError(guildId: string, channelId: string): boolean {
    const key = `${guildId}:${channelId}`;

    // 取消该 channel 待执行的重试（防止同时存在多个 timer）
    const existing = this.pendingRetries.get(key);
    if (existing) {
      clearTimeout(existing);
      this.pendingRetries.delete(key);
    }

    const count = (this.consecutiveErrors.get(key) ?? 0) + 1;
    this.consecutiveErrors.set(key, count);

    logger.warn(
      `[ApiErrorInterceptor] Consecutive API error #${count}/${ApiErrorInterceptor.MAX_RETRIES} (channel=${channelId})`,
    );

    if (count > ApiErrorInterceptor.MAX_RETRIES) {
      logger.error(
        `[ApiErrorInterceptor] Exceeded max retries (${ApiErrorInterceptor.MAX_RETRIES}) for channel ${channelId}, stopping`,
      );
      this.consecutiveErrors.delete(key);
      return false;
    }

    const delay = ApiErrorInterceptor.BASE_DELAY_MS * count;
    logger.info(`[ApiErrorInterceptor] Scheduling "continue" retry #${count} in ${delay / 1000}s`);

    const timer = setTimeout(() => {
      this.pendingRetries.delete(key);
      logger.info(`[ApiErrorInterceptor] Sending "continue" to channel ${channelId} (retry #${count})`);
      this.onRetry(guildId, channelId);
    }, delay);
    this.pendingRetries.set(key, timer);

    return true;
  }

  /**
   * 当某个 channel 的 Claude 成功响应时调用，重置该 channel 的连续错误计数。
   */
  onSuccess(guildId: string, channelId: string): void {
    const key = `${guildId}:${channelId}`;
    if (this.consecutiveErrors.has(key)) {
      logger.info(`[ApiErrorInterceptor] Successful response on channel ${channelId}, resetting error count`);
      this.consecutiveErrors.delete(key);
    }
    const timer = this.pendingRetries.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingRetries.delete(key);
    }
  }
}
