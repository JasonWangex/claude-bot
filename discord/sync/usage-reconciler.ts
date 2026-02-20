/**
 * Usage 每日对齐扫描
 *
 * 凌晨 1:00 全量重算最近 3 天 session 的 token/cost，
 * 覆盖写修正增量扫描可能的漂移。
 * 失败时 5 分钟后重试一次。
 */

import type Database from 'better-sqlite3';
import { createReadStream, readdirSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import type { PricingService } from './pricing-service.js';
import { logger } from '../utils/logger.js';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 分钟后重试

interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
}

interface ReconcileResult {
  sessionsScanned: number;
  sessionsUpdated: number;
}

export class UsageReconciler {
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private overwriteStmt: Database.Statement;

  constructor(
    private db: Database.Database,
    private claudeProjectsDir: string,
    private pricingService: PricingService,
  ) {
    this.overwriteStmt = db.prepare(`
      UPDATE claude_sessions SET
        tokens_in         = ?,
        tokens_out        = ?,
        cache_read_in     = ?,
        cache_write_in    = ?,
        cost_usd          = ?,
        turn_count        = ?,
        usage_file_offset = ?
      WHERE claude_session_id = ?
    `);
  }

  /** 启动调度 */
  start(): void {
    this.scheduleNext();
    logger.info('[UsageReconciler] Scheduled (daily at 01:00)');
  }

  /** 停止调度 */
  stop(): void {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** 手动触发（API 调用） */
  async runNow(): Promise<ReconcileResult> {
    return this.reconcile();
  }

  // ==================== 调度 ====================

  private scheduleNext(): void {
    const now = new Date();
    const target = new Date(now);
    target.setHours(1, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    const delayMs = target.getTime() - now.getTime();
    logger.debug(`[UsageReconciler] Next reconciliation in ${Math.round(delayMs / 3600000)}h`);

    this.reconcileTimer = setTimeout(async () => {
      // 刷新定价
      await this.pricingService.refreshIfNeeded();

      // 执行对齐，失败则 5 分钟后重试一次
      try {
        await this.reconcile();
      } catch (e: any) {
        logger.warn(`[UsageReconciler] Failed, retrying in 5min: ${e.message}`);
        this.reconcileTimer = setTimeout(async () => {
          try {
            await this.reconcile();
          } catch (retryErr: any) {
            logger.error(`[UsageReconciler] Retry failed: ${retryErr.message}`);
          }
          this.scheduleNext();
        }, RETRY_DELAY_MS);
        return; // scheduleNext 在 retry 的 setTimeout 里调用
      }

      this.scheduleNext();
    }, delayMs);
  }

  // ==================== 对齐逻辑 ====================

  private async reconcile(): Promise<ReconcileResult> {
    const startTime = Date.now();
    const cutoff = Date.now() - THREE_DAYS_MS;
    const result: ReconcileResult = { sessionsScanned: 0, sessionsUpdated: 0 };

    // 查询最近 3 天活跃的 session
    const sessions = this.db.prepare(`
      SELECT claude_session_id
      FROM claude_sessions
      WHERE last_activity_at > ? OR created_at > ?
    `).all(cutoff, cutoff) as Array<{ claude_session_id: string }>;

    logger.info(`[UsageReconciler] ${sessions.length} sessions in last 3 days`);

    // 逐个全量重算
    for (const { claude_session_id: sessionId } of sessions) {
      result.sessionsScanned++;

      const filePath = this.findJsonlFile(sessionId);
      if (!filePath) continue;

      const totals = await this.fullScan(filePath);

      let fileSize: number;
      try {
        fileSize = statSync(filePath).size;
      } catch {
        continue;
      }

      this.overwriteStmt.run(
        totals.tokensIn,
        totals.tokensOut,
        totals.cacheReadIn,
        totals.cacheWriteIn,
        totals.costUsd,
        totals.turnCount,
        fileSize,          // offset 对齐到文件末尾
        sessionId,
      );
      result.sessionsUpdated++;
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[UsageReconciler] Completed: ${result.sessionsUpdated}/${result.sessionsScanned} sessions, ${elapsed}ms`);
    return result;
  }

  /** 全量读取一个 JSONL 文件，返回完整 token/cost 汇总 */
  private async fullScan(filePath: string): Promise<UsageTotals> {
    const totals: UsageTotals = {
      tokensIn: 0, tokensOut: 0,
      cacheReadIn: 0, cacheWriteIn: 0,
      costUsd: 0, turnCount: 0,
    };

    const seen = new Set<string>(); // messageId:requestId 去重

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        if (event.type !== 'assistant') continue;

        const usage = event.message?.usage;
        if (!usage) continue;

        // 去重：messageId + requestId
        const msgId = event.message?.id;
        const reqId = event.requestId;
        if (msgId && reqId) {
          const hash = `${msgId}:${reqId}`;
          if (seen.has(hash)) continue;
          seen.add(hash);
        }

        totals.tokensIn += usage.input_tokens ?? 0;
        totals.tokensOut += usage.output_tokens ?? 0;
        totals.cacheReadIn += usage.cache_read_input_tokens ?? 0;
        totals.cacheWriteIn += usage.cache_creation_input_tokens ?? 0;
        totals.turnCount++;

        // 费用：优先用预计算值
        if (event.costUSD != null) {
          totals.costUsd += event.costUSD;
        } else {
          const model = event.message?.model;
          if (model) {
            totals.costUsd += this.pricingService.calculateCost(usage, model);
          }
        }
      } catch {
        continue;
      }
    }

    return totals;
  }

  /** 在项目目录中定位 session 的 JSONL 文件 */
  private findJsonlFile(sessionId: string): string | null {
    try {
      for (const entry of readdirSync(this.claudeProjectsDir)) {
        const filePath = join(this.claudeProjectsDir, entry, `${sessionId}.jsonl`);
        try {
          if (statSync(filePath).isFile()) return filePath;
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return null;
  }
}
