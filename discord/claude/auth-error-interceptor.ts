/**
 * Auth Error Interceptor
 * 统一处理 Claude 403 认证错误的自动恢复机制：
 * - 第 1 次：3 秒后向受影响的 channel 发送 "continue"
 * - 第 2 次（连续，同一 channel）：10 秒后发送 "continue"
 * - 第 3 次（连续，同一 channel）：进入紧急模式（pause 所有 goal，杀死所有 session，发送告警）
 * - 任意 channel 成功响应后重置该 channel 的计数器
 *
 * 计数器按 channel 独立维护，避免多 channel 并发错误互相干扰。
 */

import { logger } from '../utils/logger.js';

export class AuthErrorInterceptor {
  /** 每个 channel 的连续错误计数，key = `${guildId}:${channelId}` */
  private readonly consecutiveErrors = new Map<string, number>();
  /** 每个 channel 待执行的重试 timer */
  private readonly pendingRetries = new Map<string, NodeJS.Timeout>();

  private static readonly RETRY_DELAYS = [3000, 10000]; // 第 1、2 次的延迟（ms）
  private static readonly MAX_RETRIES = 2;               // 第 3 次触发紧急模式

  constructor(
    /** 重试回调：向指定 channel 发送 "continue" */
    private readonly onRetry: (guildId: string, channelId: string) => void,
    /** 紧急模式回调：pause 所有 goal，杀死所有 session，发送告警 */
    private readonly onEmergency: () => void,
  ) {}

  /**
   * 当 AUTH_ERROR 发生时调用。
   * 按 channel 独立维护连续错误计数，自动决定是重试还是进入紧急模式。
   */
  handleAuthError(guildId: string, channelId: string): void {
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
      `[AuthErrorInterceptor] Consecutive auth error #${count} (channel=${channelId})`,
    );

    if (count > AuthErrorInterceptor.MAX_RETRIES) {
      logger.error('[AuthErrorInterceptor] 3 consecutive auth errors, entering emergency mode');
      this.consecutiveErrors.delete(key);
      try {
        this.onEmergency();
      } catch (err: any) {
        logger.error('[AuthErrorInterceptor] onEmergency callback failed:', err.message);
      }
      return;
    }

    const delay = AuthErrorInterceptor.RETRY_DELAYS[count - 1];
    logger.info(`[AuthErrorInterceptor] Scheduling "continue" retry in ${delay / 1000}s`);

    const timer = setTimeout(() => {
      this.pendingRetries.delete(key);
      logger.info(`[AuthErrorInterceptor] Sending "continue" to channel ${channelId}`);
      this.onRetry(guildId, channelId);
    }, delay);
    this.pendingRetries.set(key, timer);
  }

  /**
   * 当某个 channel 的 Claude 成功响应时调用，重置该 channel 的连续错误计数。
   */
  onSuccess(guildId: string, channelId: string): void {
    const key = `${guildId}:${channelId}`;
    if (this.consecutiveErrors.has(key)) {
      logger.info(`[AuthErrorInterceptor] Successful response on channel ${channelId}, resetting error count`);
      this.consecutiveErrors.delete(key);
    }
    const timer = this.pendingRetries.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingRetries.delete(key);
    }
  }
}
