/**
 * Usage 每日对齐扫描
 *
 * 凌晨 1:00 全量重算最近 3 天 session 的 token/cost，
 * 覆盖写修正增量扫描可能的漂移。
 * 失败时 5 分钟后重试一次。
 */

import type Database from 'better-sqlite3';
import { createReadStream, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import type { PricingService } from './pricing-service.js';
import { logger } from '../utils/logger.js';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 分钟后重试

interface ModelStats {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
}

interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
  byModel: Record<string, ModelStats>;
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
        usage_file_offset = ?,
        model_usage       = ?
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

  /** 手动触发最近 3 天（API 调用） */
  async runNow(): Promise<ReconcileResult> {
    return this.reconcile();
  }

  /** 全量重算所有 session 的 usage（一次性历史数据同步） */
  async reconcileAll(): Promise<ReconcileResult> {
    return this.reconcile(true);
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

  private async reconcile(all = false): Promise<ReconcileResult> {
    const startTime = Date.now();
    const result: ReconcileResult = { sessionsScanned: 0, sessionsUpdated: 0 };

    let sessions: Array<{ claude_session_id: string }>;
    if (all) {
      sessions = this.db.prepare(
        'SELECT claude_session_id FROM claude_sessions',
      ).all() as Array<{ claude_session_id: string }>;
      logger.info(`[UsageReconciler] Full reconciliation: ${sessions.length} sessions`);
    } else {
      const cutoff = Date.now() - THREE_DAYS_MS;
      sessions = this.db.prepare(`
        SELECT claude_session_id
        FROM claude_sessions
        WHERE last_activity_at > ? OR created_at > ?
      `).all(cutoff, cutoff) as Array<{ claude_session_id: string }>;
      logger.info(`[UsageReconciler] ${sessions.length} sessions in last 3 days`);
    }

    // 预建旧格式 agent 文件索引：sessionId -> [filePaths]
    const oldAgentIndex = this.buildOldAgentIndex();

    // 逐个全量重算
    for (const { claude_session_id: sessionId } of sessions) {
      result.sessionsScanned++;

      const filePath = this.findJsonlFile(sessionId);
      if (!filePath) continue;

      const totals = await this.fullScan(filePath);

      // 聚合子 agent 用量（新格式：<SESSION_ID>/subagents/ 目录）
      const subagentsDir = join(dirname(filePath), sessionId, 'subagents');
      const agentTotals = await this.scanSubagentsDir(subagentsDir);
      mergeTotals(totals, agentTotals);

      // 聚合子 agent 用量（旧格式：agent-*.jsonl 通过索引关联）
      for (const agentFile of oldAgentIndex.get(sessionId) ?? []) {
        const t = await this.fullScan(agentFile);
        mergeTotals(totals, t);
      }

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
        Object.keys(totals.byModel).length > 0 ? JSON.stringify(totals.byModel) : null,
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
      byModel: {},
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

        const tokensIn = usage.input_tokens ?? 0;
        const tokensOut = usage.output_tokens ?? 0;
        const cacheReadIn = usage.cache_read_input_tokens ?? 0;
        const cacheWriteIn = usage.cache_creation_input_tokens ?? 0;

        totals.tokensIn += tokensIn;
        totals.tokensOut += tokensOut;
        totals.cacheReadIn += cacheReadIn;
        totals.cacheWriteIn += cacheWriteIn;
        totals.turnCount++;

        // 费用：优先用预计算值
        let eventCost = 0;
        if (event.costUSD != null) {
          eventCost = event.costUSD;
        } else {
          const model = event.message?.model;
          if (model) {
            eventCost = this.pricingService.calculateCost(usage, model);
          }
        }
        totals.costUsd += eventCost;

        // 按模型分类累加
        const model: string = event.message?.model ?? 'unknown';
        if (!totals.byModel[model]) {
          totals.byModel[model] = {
            tokensIn: 0, tokensOut: 0,
            cacheReadIn: 0, cacheWriteIn: 0,
            costUsd: 0, turnCount: 0,
          };
        }
        totals.byModel[model].tokensIn += tokensIn;
        totals.byModel[model].tokensOut += tokensOut;
        totals.byModel[model].cacheReadIn += cacheReadIn;
        totals.byModel[model].cacheWriteIn += cacheWriteIn;
        totals.byModel[model].costUsd += eventCost;
        totals.byModel[model].turnCount++;
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

  /**
   * 扫描所有项目目录，建立旧格式 agent 文件的 sessionId 索引
   * 旧格式：<PROJECT>/agent-*.jsonl，首行有 sessionId 字段
   */
  private buildOldAgentIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    try {
      for (const projectEntry of readdirSync(this.claudeProjectsDir)) {
        const projectDir = join(this.claudeProjectsDir, projectEntry);
        try {
          for (const entry of readdirSync(projectDir)) {
            if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
            const filePath = join(projectDir, entry);
            const sessionId = readFirstLineSessionId(filePath);
            if (sessionId) {
              if (!index.has(sessionId)) index.set(sessionId, []);
              index.get(sessionId)!.push(filePath);
            }
          }
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return index;
  }

  /**
   * 扫描 subagents 目录下所有 agent-*.jsonl 文件，返回聚合用量
   * 目录不存在时静默返回空统计
   */
  private async scanSubagentsDir(subagentsDir: string): Promise<UsageTotals> {
    const totals: UsageTotals = {
      tokensIn: 0, tokensOut: 0,
      cacheReadIn: 0, cacheWriteIn: 0,
      costUsd: 0, turnCount: 0,
      byModel: {},
    };

    try {
      const entries = readdirSync(subagentsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl') || !entry.startsWith('agent-')) continue;
        try {
          const agentTotals = await this.fullScan(join(subagentsDir, entry));
          mergeTotals(totals, agentTotals);
        } catch { /* 单个 agent 文件失败不影响整体 */ }
      }
    } catch { /* subagents 目录不存在，正常情况 */ }

    return totals;
  }
}

/** 读取 agent 文件首行的 sessionId 字段（读前 512 字节） */
function readFirstLineSessionId(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const newline = text.indexOf('\n');
    const line = newline === -1 ? text : text.slice(0, newline);
    const event = JSON.parse(line);
    return typeof event.sessionId === 'string' ? event.sessionId : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** 将 src 的用量累加到 dst 中（in-place） */
function mergeTotals(dst: UsageTotals, src: UsageTotals): void {
  dst.tokensIn += src.tokensIn;
  dst.tokensOut += src.tokensOut;
  dst.cacheReadIn += src.cacheReadIn;
  dst.cacheWriteIn += src.cacheWriteIn;
  dst.costUsd += src.costUsd;
  dst.turnCount += src.turnCount;
  for (const [model, stats] of Object.entries(src.byModel)) {
    if (!dst.byModel[model]) {
      dst.byModel[model] = { tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheWriteIn: 0, costUsd: 0, turnCount: 0 };
    }
    dst.byModel[model].tokensIn += stats.tokensIn;
    dst.byModel[model].tokensOut += stats.tokensOut;
    dst.byModel[model].cacheReadIn += stats.cacheReadIn;
    dst.byModel[model].cacheWriteIn += stats.cacheWriteIn;
    dst.byModel[model].costUsd += stats.costUsd;
    dst.byModel[model].turnCount += stats.turnCount;
  }
}
