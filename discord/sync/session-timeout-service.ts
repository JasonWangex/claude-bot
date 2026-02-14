/**
 * Session 超时监控服务
 *
 * 定期检查 waiting/idle 状态的 session，超过 30 分钟无活动则自动关闭
 */

import type { ClaudeSessionRepository } from '../db/repo/claude-session-repo.js';
import { logger } from '../utils/logger.js';

export class SessionTimeoutService {
  private timer: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL = 5 * 60 * 1000;  // 5分钟检查一次
  private readonly TIMEOUT = 30 * 60 * 1000;        // 30分钟超时

  constructor(private claudeSessionRepo: ClaudeSessionRepository) {}

  /**
   * 启动超时监控
   */
  start(): void {
    if (this.timer) {
      logger.warn('[SessionTimeout] Service already running');
      return;
    }

    logger.info('[SessionTimeout] Starting session timeout monitoring');

    this.timer = setInterval(() => {
      this.checkTimeouts().catch((err) => {
        logger.error('[SessionTimeout] Check failed:', err);
      });
    }, this.CHECK_INTERVAL);

    // 启动时立即执行一次
    this.checkTimeouts().catch((err) => {
      logger.error('[SessionTimeout] Initial check failed:', err);
    });
  }

  /**
   * 停止超时监控
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[SessionTimeout] Stopped session timeout monitoring');
    }
  }

  /**
   * 检查并关闭超时的 session
   */
  private async checkTimeouts(): Promise<void> {
    const now = Date.now();
    const threshold = now - this.TIMEOUT;

    // 加载所有 session（实际应该用专门的查询方法，但当前 repo 没有提供）
    const allSessions = this.claudeSessionRepo.loadAll();

    let closedCount = 0;

    for (const session of allSessions) {
      // 只检查 waiting/idle 状态的 session
      if (session.status !== 'waiting' && session.status !== 'idle') {
        continue;
      }

      // 检查 lastActivityAt 是否超时
      const lastActivity = session.lastActivityAt || session.createdAt;
      if (lastActivity < threshold) {
        logger.warn(`[SessionTimeout] Closing inactive session: ${session.id} (${session.claudeSessionId?.slice(0, 8)}) - last activity: ${new Date(lastActivity).toISOString()}`);

        await this.claudeSessionRepo.close(session.id);
        closedCount++;
      }
    }

    if (closedCount > 0) {
      logger.info(`[SessionTimeout] Closed ${closedCount} inactive session(s)`);
    }
  }
}
