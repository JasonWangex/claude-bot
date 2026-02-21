# Session Token 统计与费用计算实现指南

生成时间: 2026-02-20

## 概述

为 claude-bot 添加 Session 级 token/cost 累计统计，采用双层扫描策略：

1. **实时增量扫描**（60s）— 嵌入现有 `SessionSyncService` 循环，通过 byte offset 只读 JSONL 文件新增部分，累加 delta
2. **每日对齐扫描**（凌晨 1:00）— 全量重算最近 3 天的 session 数据，覆盖写，修正任何漂移，带一次重试

```
实时层（60s）                         对齐层（每日 01:00）
─────────────                        ──────────────────
读取: offset → EOF（新增几行）         读取: 整个文件（全量）
写入: tokens += delta（累加）          写入: tokens = total（覆盖）
作用: 及时反映最新用量                  作用: 修正漂移，保证最终一致
```

---

## 一、数据库改动

### Migration 013

```typescript
// discord/db/migrations/013_add_session_usage.ts
import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 13,
  name: 'add_session_usage',

  up(db) {
    db.exec(`
      ALTER TABLE claude_sessions ADD COLUMN tokens_in          INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN tokens_out         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN cache_read_in      INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN cache_write_in     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN cost_usd           REAL    NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN turn_count         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN usage_file_offset  INTEGER NOT NULL DEFAULT 0;
    `);
  },

  down(db) {
    db.exec(`
      UPDATE claude_sessions SET
        tokens_in = 0, tokens_out = 0,
        cache_read_in = 0, cache_write_in = 0,
        cost_usd = 0, turn_count = 0,
        usage_file_offset = 0
    `);
  },
};

export default migration;
```

### 字段说明

| 列 | 类型 | 说明 |
|----|------|------|
| `tokens_in` | INTEGER | 累计 input tokens |
| `tokens_out` | INTEGER | 累计 output tokens |
| `cache_read_in` | INTEGER | 累计 cache read tokens |
| `cache_write_in` | INTEGER | 累计 cache creation tokens |
| `cost_usd` | REAL | 累计费用（美元） |
| `turn_count` | INTEGER | 去重后的 assistant 消息数 |
| `usage_file_offset` | INTEGER | 增量扫描的文件字节偏移量 |

### 类型更新

```typescript
// discord/types/db.ts — ClaudeSessionRow 添加
tokens_in: number;
tokens_out: number;
cache_read_in: number;
cache_write_in: number;
cost_usd: number;
turn_count: number;
usage_file_offset: number;

// discord/types/index.ts — ClaudeSession 添加
tokensIn?: number;
tokensOut?: number;
cacheReadIn?: number;
cacheWriteIn?: number;
costUsd?: number;
turnCount?: number;
usageFileOffset?: number;
```

---

## 二、LiteLLM 定价服务

### PricingService

```typescript
// discord/sync/pricing-service.ts

import { readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

interface ModelPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_FILE = join(import.meta.dirname, '../../data/litellm-pricing.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class PricingService {
  private pricing = new Map<string, ModelPricing>();
  private lastFetchAt = 0;

  /** 启动时调用：加载缓存，过期则拉新 */
  async init(): Promise<void> {
    if (this.loadFromCache()) {
      if (Date.now() - this.lastFetchAt < CACHE_MAX_AGE_MS) {
        logger.info(`Pricing loaded from cache (${this.pricing.size} models)`);
        return;
      }
    }
    await this.fetchAndCache();
  }

  /** 每日刷新（对齐扫描前调用） */
  async refreshIfNeeded(): Promise<void> {
    if (Date.now() - this.lastFetchAt < CACHE_MAX_AGE_MS) return;
    await this.fetchAndCache();
  }

  /** 计算单条记录费用 */
  calculateCost(usage: TokenUsage, model: string): number {
    const p = this.getPricing(model);
    if (!p) return 0;

    return (usage.input_tokens * p.input_cost_per_token)
         + (usage.output_tokens * p.output_cost_per_token)
         + ((usage.cache_read_input_tokens ?? 0) * (p.cache_read_input_token_cost ?? p.input_cost_per_token))
         + ((usage.cache_creation_input_tokens ?? 0) * (p.cache_creation_input_token_cost ?? p.input_cost_per_token));
  }

  /** 查找模型定价：精确 → 带 provider 前缀 → 子串 */
  private getPricing(model: string): ModelPricing | null {
    if (this.pricing.has(model)) return this.pricing.get(model)!;
    const prefixed = `anthropic/${model}`;
    if (this.pricing.has(prefixed)) return this.pricing.get(prefixed)!;
    for (const [key, value] of this.pricing) {
      if (key.includes(model) || model.includes(key)) return value;
    }
    return null;
  }

  private async fetchAndCache(): Promise<void> {
    try {
      const res = await fetch(LITELLM_URL);
      const json = await res.json() as Record<string, any>;
      this.pricing.clear();
      for (const [key, value] of Object.entries(json)) {
        if ((key.includes('claude') || key.startsWith('anthropic/')) && value.input_cost_per_token != null) {
          this.pricing.set(key, {
            input_cost_per_token: value.input_cost_per_token,
            output_cost_per_token: value.output_cost_per_token,
            cache_read_input_token_cost: value.cache_read_input_token_cost,
            cache_creation_input_token_cost: value.cache_creation_input_token_cost,
          });
        }
      }
      writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), models: Object.fromEntries(this.pricing) }));
      this.lastFetchAt = Date.now();
      logger.info(`Pricing fetched: ${this.pricing.size} Claude models`);
    } catch (e: any) {
      logger.warn(`Failed to fetch pricing: ${e.message}`);
    }
  }

  private loadFromCache(): boolean {
    try {
      const raw = readFileSync(CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw) as { fetchedAt: number; models: Record<string, ModelPricing> };
      this.pricing = new Map(Object.entries(data.models));
      this.lastFetchAt = data.fetchedAt;
      return true;
    } catch {
      return false;
    }
  }
}
```

---

## 三、实时增量扫描（60s，嵌入 SessionSyncService）

### 3.1 原理

```
文件:  [████████████████████████████████░░░░░░]
                                      ↑        ↑
                                  offset    fileSize
                                      |← 只读这段 →|
```

- `usage_file_offset` 记录上次读到的字节位置
- 每次只从 offset 读到 EOF，解析新增行
- 累加 delta 到现有 DB 值（`tokens_in += delta`）
- 更新 offset 为当前 fileSize

### 3.2 嵌入位置

在 `SessionSyncService.processJsonlFileSync()` 末尾追加增量 usage 读取：

```typescript
// discord/sync/session-sync-service.ts — processJsonlFileSync 末尾

// === 增量 usage 扫描 ===
const currentOffset = existingRow?.usage_file_offset ?? 0;
const fileSize = fileStat.size;

if (fileSize > currentOffset) {
  const delta = await this.readUsageDelta(jsonlPath, currentOffset);
  if (delta.turnCount > 0) {
    this.usageAccumulateStmt.run(
      delta.tokensIn,
      delta.tokensOut,
      delta.cacheReadIn,
      delta.cacheWriteIn,
      delta.costUsd,
      delta.turnCount,
      fileSize,        // 新 offset
      claudeSessionId,
    );
  } else {
    // 文件变大了但没有新的 assistant usage（可能是 user/system 事件）
    // 仅更新 offset
    this.usageOffsetStmt.run(fileSize, claudeSessionId);
  }
}
```

### 3.3 增量读取实现

```typescript
// discord/sync/session-sync-service.ts — 新增方法

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

interface UsageDelta {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
}

/**
 * 从 byte offset 开始读取新增行，提取 usage delta
 *
 * 注意：offset 可能落在行中间，readline 会把该"半行"作为第一行返回，
 * JSON.parse 会失败，被 try/catch 安全跳过。
 */
private async readUsageDelta(filePath: string, offset: number): Promise<UsageDelta> {
  const delta: UsageDelta = {
    tokensIn: 0, tokensOut: 0,
    cacheReadIn: 0, cacheWriteIn: 0,
    costUsd: 0, turnCount: 0,
  };

  const stream = createReadStream(filePath, { start: offset, encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (event.type !== 'assistant') continue;

      const usage = event.message?.usage;
      if (!usage) continue;

      delta.tokensIn += usage.input_tokens ?? 0;
      delta.tokensOut += usage.output_tokens ?? 0;
      delta.cacheReadIn += usage.cache_read_input_tokens ?? 0;
      delta.cacheWriteIn += usage.cache_creation_input_tokens ?? 0;
      delta.turnCount++;

      // 费用：优先用预计算值
      if (event.costUSD != null) {
        delta.costUsd += event.costUSD;
      } else {
        const model = event.message?.model;
        if (model) {
          delta.costUsd += this.pricingService.calculateCost(usage, model);
        }
      }
    } catch {
      // offset 截断的半行、格式错误等，安全跳过
      continue;
    }
  }

  return delta;
}
```

### 3.4 预编译 SQL 语句

```typescript
// SessionSyncService constructor 中添加

// 累加 delta
this.usageAccumulateStmt = db.prepare(`
  UPDATE claude_sessions SET
    tokens_in          = tokens_in      + ?,
    tokens_out         = tokens_out     + ?,
    cache_read_in      = cache_read_in  + ?,
    cache_write_in     = cache_write_in + ?,
    cost_usd           = cost_usd       + ?,
    turn_count         = turn_count     + ?,
    usage_file_offset  = ?
  WHERE claude_session_id = ?
`);

// 仅更新 offset（无新 usage 时）
this.usageOffsetStmt = db.prepare(`
  UPDATE claude_sessions SET usage_file_offset = ?
  WHERE claude_session_id = ?
`);
```

### 3.5 边界情况处理

| 情况 | 处理 |
|------|------|
| offset 落在行中间 | 第一行 JSON.parse 失败，catch 跳过，从下一完整行开始 |
| 文件被截断（size < offset） | `createReadStream({ start })` 读到空流，delta 全为 0，offset 不变 |
| 文件不存在 | `processJsonlFileSync` 本身就有 try/catch |
| 新建 session（offset = 0） | 等于读整个文件，首次自然建立完整数据 |
| agent-* 文件 | `extractSessionMetadata` 返回 null，整个方法 return 'skipped' |
| 多个文件属于同一 session | Claude Code 每个 session 一个文件，不会出现 |

---

## 四、每日对齐扫描（凌晨 1:00，最近 3 天，一次重试）

### 4.1 职责

- **修正漂移**：增量累加可能因 offset 截断丢失少量 token，对齐扫描用全量覆盖修正
- **补漏**：启动期间遗漏的文件、offset 异常等
- **定价更新后重算**：LiteLLM 定价每日刷新，对齐扫描用最新价格重算

### 4.2 实现

```typescript
// discord/sync/usage-reconciler.ts

import type Database from 'better-sqlite3';
import { createReadStream, readdirSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join, basename } from 'path';
import type { PricingService } from './pricing-service.js';
import { logger } from '../utils/logger.js';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 分钟后重试

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
    logger.info('UsageReconciler scheduled (daily at 01:00)');
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
    logger.debug(`Next reconciliation in ${Math.round(delayMs / 3600000)}h`);

    this.reconcileTimer = setTimeout(async () => {
      // 刷新定价
      await this.pricingService.refreshIfNeeded();

      // 执行对齐，失败则 5 分钟后重试一次
      try {
        await this.reconcile();
      } catch (e: any) {
        logger.warn(`Reconciliation failed, retrying in 5min: ${e.message}`);
        setTimeout(async () => {
          try {
            await this.reconcile();
          } catch (retryErr: any) {
            logger.error(`Reconciliation retry failed: ${retryErr.message}`);
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

    // 1. 查询最近 3 天活跃的 session
    const sessions = this.db.prepare(`
      SELECT claude_session_id
      FROM claude_sessions
      WHERE last_activity_at > ? OR created_at > ?
    `).all(cutoff, cutoff) as Array<{ claude_session_id: string }>;

    logger.info(`Reconciliation: ${sessions.length} sessions in last 3 days`);

    // 2. 逐个全量重算
    for (const { claude_session_id: sessionId } of sessions) {
      result.sessionsScanned++;

      const filePath = this.findJsonlFile(sessionId);
      if (!filePath) continue;

      const totals = await this.fullScan(filePath);
      const fileSize = statSync(filePath).size;

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
    logger.info(`Reconciliation completed: ${result.sessionsUpdated}/${result.sessionsScanned} sessions, ${elapsed}ms`);
    return result;
  }

  /** 全量读取一个 JSONL 文件，返回完整 token/cost 汇总 */
  private async fullScan(filePath: string): Promise<UsageTotals> {
    const totals: UsageTotals = {
      tokensIn: 0, tokensOut: 0,
      cacheReadIn: 0, cacheWriteIn: 0,
      costUsd: 0, turnCount: 0,
    };

    const seen = new Set<string>(); // 去重

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

        // 去重
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
```

---

## 五、两层协作关系

### 5.1 时间线示例

```
一天内某个活跃 session 的处理时间线:

09:00  SessionSync 发现文件变更 → 读 16KB 元数据 + 从 offset 读 2KB 新增 → delta 累加
09:01  SessionSync 再次发现变更 → 读 16KB + 从新 offset 读 500B → delta 累加
 ...   （每 60s 重复，只读新追加的几百字节）
23:59  当天最后一次增量扫描

01:00  UsageReconciler 触发 → 全量读取 120MB 文件 → 覆盖写 → offset 对齐
       此刻 DB 值 = 文件完整统计（修正了所有可能的漂移）

01:01  新的一天，增量扫描继续从 120MB offset 开始
```

### 5.2 数据一致性保证

| 场景 | 增量层行为 | 对齐层行为 |
|------|-----------|-----------|
| 正常追加 | offset 前进，delta 累加 ✓ | 无事发生 |
| offset 截断半行丢失 1 条 | 少计 1 条（微小误差） | 次日 1:00 覆盖修正 ✓ |
| Bot 重启，offset 从 DB 恢复 | 从上次 offset 继续 ✓ | 次日 1:00 全量校准 ✓ |
| 首次迁移（所有 offset = 0） | 等于全量读取所有文件 | 次日 1:00 再次确认 ✓ |
| LiteLLM 定价更新 | 增量计算用旧价格（微小误差） | 1:00 刷新定价后重算 ✓ |
| 文件被外部修改/截断 | size < offset，跳过 | 全量重读，覆盖修正 ✓ |

### 5.3 性能对比

假设 10 个活跃 session，文件各 100MB，每 60s 各追加 5KB：

| 层 | 频率 | 单次 IO | 日总 IO |
|----|------|---------|---------|
| 增量层 | 每 60s | 10 × 5KB = **50KB** | 50KB × 1440 = **72MB** |
| 对齐层 | 每日 1:00 | 10 × 100MB = **1GB** | **1GB** |
| **总计** | | | **~1.07GB/日** |

对比"每 60s 全量读取"方案：

| | 每次 IO | 日总 IO |
|-|---------|---------|
| 全量 60s | 10 × 100MB = 1GB | 1GB × 1440 = **1.4TB/日** |
| 双层方案 | 见上 | **~1.07GB/日** |

**节省 1300 倍 IO**。

---

## 六、集成到 Bot

### 6.1 启动顺序

```typescript
// discord/bot/discord.ts

import { PricingService } from '../sync/pricing-service.js';
import { UsageReconciler } from '../sync/usage-reconciler.js';

// 1. 定价服务（其他服务依赖它）
const pricingService = new PricingService();
await pricingService.init();

// 2. SessionSyncService（60s 元数据 + 增量 usage）
const sessionSyncService = new SessionSyncService(db, claudeProjectsDir, pricingService);
sessionSyncService.start();
//    ↑ 首次启动时 syncAll() 会：
//      - 创建所有 session 行
//      - 对每个文件从 offset=0 读取全量 usage（首次迁移）

// 3. UsageReconciler（每日 01:00 对齐）
const usageReconciler = new UsageReconciler(db, claudeProjectsDir, pricingService);
usageReconciler.start();

// shutdown 时
sessionSyncService.stop();
usageReconciler.stop();
```

### 6.2 SessionSyncService 改动总结

```diff
 class SessionSyncService {
+  private pricingService: PricingService;
+  private usageAccumulateStmt: Database.Statement;
+  private usageOffsetStmt: Database.Statement;

-  constructor(db, claudeProjectsDir) {
+  constructor(db, claudeProjectsDir, pricingService) {
+    this.pricingService = pricingService;
+    this.usageAccumulateStmt = db.prepare(`...`);
+    this.usageOffsetStmt = db.prepare(`...`);
   }

   private processJsonlFileSync(jsonlPath): 'created' | 'updated' | 'skipped' {
     // ... 现有元数据处理逻辑不变 ...

+    // === 增量 usage 扫描 ===
+    const currentOffset = existingRow?.usage_file_offset ?? 0;
+    const fileSize = fileStat.size;
+    if (fileSize > currentOffset) {
+      const delta = await this.readUsageDelta(jsonlPath, currentOffset);
+      if (delta.turnCount > 0) {
+        this.usageAccumulateStmt.run(...delta, fileSize, claudeSessionId);
+      } else {
+        this.usageOffsetStmt.run(fileSize, claudeSessionId);
+      }
+    }

     return result;
   }

+  private async readUsageDelta(filePath, offset): Promise<UsageDelta> { ... }
 }
```

### 6.3 手动触发 API（可选）

```typescript
// discord/api/routes/usage.ts

// 手动触发对齐扫描
router.post('/api/usage/reconcile', async (req, res) => {
  const result = await usageReconciler.runNow();
  res.json({ success: true, ...result });
});

// 查询 session 用量
router.get('/api/usage/session/:sessionId', (req, res) => {
  const row = db.prepare(`
    SELECT claude_session_id, model, title,
           tokens_in, tokens_out, cache_read_in, cache_write_in,
           cost_usd, turn_count, created_at, last_activity_at
    FROM claude_sessions WHERE claude_session_id = ?
  `).get(req.params.sessionId);
  res.json(row ?? null);
});

// 按日汇总
router.get('/api/usage/daily', (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const rows = db.prepare(`
    SELECT DATE(created_at / 1000, 'unixepoch', 'localtime') AS day,
           COUNT(*) AS sessions,
           SUM(tokens_in + tokens_out) AS total_tokens,
           SUM(cost_usd) AS total_cost
    FROM claude_sessions
    WHERE created_at > (strftime('%s', 'now', '-' || ? || ' days') * 1000)
      AND turn_count > 0
    GROUP BY day ORDER BY day DESC
  `).all(days);
  res.json(rows);
});
```

---

## 七、实现文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `discord/db/migrations/013_add_session_usage.ts` | **新增** | 7 个新列 |
| `discord/sync/pricing-service.ts` | **新增** | LiteLLM 定价获取与缓存 |
| `discord/sync/usage-reconciler.ts` | **新增** | 每日对齐扫描（01:00，3 天，一次重试） |
| `discord/sync/session-sync-service.ts` | **修改** | 注入 PricingService，添加增量 usage 读取 |
| `discord/types/db.ts` | **修改** | `ClaudeSessionRow` 添加 7 个字段 |
| `discord/types/index.ts` | **修改** | `ClaudeSession` 添加 7 个可选字段 |
| `discord/db/repo/claude-session-repo.ts` | **修改** | 映射函数添加新字段 |
| `discord/bot/discord.ts` | **修改** | 初始化 PricingService + UsageReconciler |
| `discord/api/routes/usage.ts` | **新增（可选）** | REST API |

---

## 八、JSONL 字段参考

### 事件过滤

只有 `type === 'assistant'` 的事件包含 usage：

```jsonc
{
  "type": "assistant",
  "message": {
    "id": "msg_01ABC...",       // 去重用
    "model": "claude-sonnet-4-20250514",
    "usage": {
      "input_tokens": 1500,
      "output_tokens": 800,
      "cache_creation_input_tokens": 200,
      "cache_read_input_tokens": 1000
    }
  },
  "costUSD": 0.012,            // 预计算费用（可选）
  "requestId": "req_01XYZ..."  // 去重用
}
```

### 费用优先级

```
costUSD 存在 → 直接用
costUSD 缺失 → LiteLLM 定价计算
定价也缺失 → 记为 0（对齐扫描定价刷新后可修正）
```

### 去重

- **增量层不去重**：因为文件是追加写入的，同一 offset 范围内不会有重复
- **对齐层用 `messageId:requestId` 去重**：全量读取可能遇到历史重复条目
