# Token 使用统计实现方案调研

## 问题

当前实现是从 Claude API 的 stream-json 响应中提取 `usage` 数据（`input_tokens` + `output_tokens`），但这种方式存在局限性：

1. **数据来源不一致**：Claude Code CLI 本身已经维护了完整的使用统计
2. **重复实现**：自己计算费用和统计，而 CLI 已经有现成数据
3. **数据可能不准确**：prompt caching 等特性会影响实际计费

## Claude Code CLI 内置统计

### 数据位置

**`~/.claude/stats-cache.json`** - Claude Code 官方统计缓存

```json
{
  "version": 2,
  "lastComputedDate": "2026-02-08",
  "dailyActivity": [
    {
      "date": "2026-02-08",
      "messageCount": 4287,
      "sessionCount": 24,
      "toolCallCount": 1129
    }
  ],
  "dailyModelTokens": [
    {
      "date": "2026-02-08",
      "tokensByModel": {
        "claude-opus-4-6": 129529
      }
    }
  ],
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 35439,
      "outputTokens": 203223,
      "cacheReadInputTokens": 199082689,
      "cacheCreationInputTokens": 16504192,
      "webSearchRequests": 0,
      "costUSD": 0,
      "contextWindow": 0,
      "maxOutputTokens": 0
    }
  },
  "totalSessions": 161,
  "totalMessages": 65036,
  "longestSession": {...},
  "hourCounts": {
    "9": 9,
    "10": 30,
    ...
  }
}
```

### 关键数据字段

#### 1. dailyActivity
- `date`: 日期
- `messageCount`: 消息数
- `sessionCount`: 会话数
- `toolCallCount`: 工具调用次数

#### 2. dailyModelTokens
- `date`: 日期
- `tokensByModel`: 按模型的 token 总量（**但这是总量，没有区分输入/输出**）

#### 3. modelUsage（累计数据）
- `inputTokens`: 输入 token
- `outputTokens`: 输出 token
- `cacheReadInputTokens`: **Prompt Caching 读取的 token**
- `cacheCreationInputTokens`: **Prompt Caching 创建的 token**
- `costUSD`: 费用（**目前为 0，CLI 不计费**）

#### 4. hourCounts
- 按小时的会话开始次数

### 发现的问题

1. **`dailyModelTokens` 只有总量**，没有区分输入/输出
2. **`modelUsage` 是累计数据**，不是按天分解
3. **Prompt Caching 数据很大**（199M cache read tokens），但当前方案未考虑
4. **CLI 自己不计算 costUSD**（为 0）

## 两种方案对比

### 方案 A：当前实现（从 API 响应提取）

**数据来源**: `ClaudeResponse.usage`
```typescript
{
  input_tokens: number;
  output_tokens: number;
}
```

**优点**:
- ✅ 数据精确（来自实际 API 响应）
- ✅ 包含输入/输出区分
- ✅ 可以记录每次调用的详细信息
- ✅ 支持按 Topic 统计

**缺点**:
- ❌ 忽略了 Prompt Caching 的 token
- ❌ 费用计算可能不准确（不考虑 cache）
- ❌ 无法统计非 Telegram 调用（直接用 CLI）

### 方案 B：读取 CLI 官方统计

**数据来源**: `~/.claude/stats-cache.json`

**优点**:
- ✅ 官方数据，包含 Prompt Caching
- ✅ 包含所有 CLI 使用（不限于 Telegram）
- ✅ 有按天的活动统计
- ✅ 有按小时的会话统计

**缺点**:
- ❌ `dailyModelTokens` 不区分输入/输出
- ❌ 没有按 Topic 的详细统计
- ❌ 文件格式可能变化（依赖 CLI 实现）
- ❌ 无法记录单次调用详情

## 推荐方案：混合方案

### 设计思路

**主要统计**: 从 CLI `stats-cache.json` 读取
- 日活跃度（消息数、会话数、工具调用）
- 按模型的总 token（包含 cache）
- 按小时分布

**补充统计**: 从 Telegram Bot 自己记录
- 按 Topic 的使用量
- 单次调用的输入/输出详情
- 费用估算（考虑 cache 的折扣）

### 实现方案

#### 1. 创建 CLI 统计读取器

```typescript
// telegram/bot/cli-stats-reader.ts
export class CLIStatsReader {
  private statsPath = join(homedir(), '.claude', 'stats-cache.json');

  async readDailyStats(date: string): Promise<DailyStats> {
    const data = await readFile(this.statsPath, 'utf-8');
    const stats = JSON.parse(data);

    // 查找对应日期的数据
    const activity = stats.dailyActivity.find(d => d.date === date);
    const modelTokens = stats.dailyModelTokens.find(d => d.date === date);

    return {
      date,
      messageCount: activity?.messageCount || 0,
      sessionCount: activity?.sessionCount || 0,
      toolCallCount: activity?.toolCallCount || 0,
      tokensByModel: modelTokens?.tokensByModel || {},
      // 从累计数据推算费用
      estimatedCostUSD: this.calculateCost(modelTokens),
    };
  }

  private calculateCost(modelTokens: any): number {
    // 考虑 Prompt Caching 的折扣
    // Cache write: 25% discount
    // Cache read: 90% discount
    // ...
  }
}
```

#### 2. 保留现有 UsageTracker（补充统计）

```typescript
// 用于记录 Telegram 特有的详细信息
class UsageTracker {
  track(params: {
    topicId: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    // ... 按 Topic 的详细记录
  }): void;
}
```

#### 3. 合并展示

```typescript
async handleUsage(ctx: Context): Promise<void> {
  // 1. 从 CLI 读取官方统计（主要数据）
  const cliStats = await this.cliStatsReader.readDailyStats(dateStr);

  // 2. 从 UsageTracker 读取 Topic 分解
  const topicBreakdown = this.usageTracker.getTopicBreakdown(dateStr);

  // 3. 合并展示
  const report = formatMergedReport(cliStats, topicBreakdown);
  await ctx.reply(report);
}
```

## Prompt Caching 费用计算

根据 Anthropic 定价：
- **Cache Write**: 25% discount (即 75% 价格)
- **Cache Read**: 90% discount (即 10% 价格)

### 修正后的费用计算

```typescript
function calculateRealCost(model: string, usage: ModelUsage): number {
  const pricing = MODEL_PRICING[model];

  // 普通输入 token
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;

  // Cache creation (75% 价格)
  const cacheCreateCost = (usage.cacheCreationInputTokens / 1_000_000) * pricing.input * 0.75;

  // Cache read (10% 价格)
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000) * pricing.input * 0.10;

  // 输出 token
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;

  return inputCost + cacheCreateCost + cacheReadCost + outputCost;
}
```

### 实际示例（2026-02-08 数据）

```
claude-opus-4-6:
  inputTokens: 35,439
  outputTokens: 203,223
  cacheReadInputTokens: 199,082,689
  cacheCreationInputTokens: 16,504,192

不考虑 cache 的费用（错误）:
  = (35439/1M * $15) + (203223/1M * $75)
  = $0.53 + $15.24
  = $15.77

考虑 cache 的费用（正确）:
  普通输入: 35439/1M * $15 = $0.53
  Cache write: 16504192/1M * $15 * 0.75 = $185.67
  Cache read: 199082689/1M * $15 * 0.10 = $298.62
  输出: 203223/1M * $75 = $15.24

  总计 = $500.06

差异: $500.06 vs $15.77 = 32倍！
```

## 最终建议

### 短期方案（保持当前实现）

1. **修正费用计算**：当前从 `response.total_cost_usd` 获取（如果有）
2. **添加 cache tokens 字段**：记录 `cacheReadInputTokens` 和 `cacheCreationInputTokens`
3. **更新报告格式**：显示 cache 使用情况

### 长期方案（推荐）

1. **读取 CLI 官方统计**作为主要数据源
2. **保留 UsageTracker** 用于：
   - 按 Topic 的详细分解
   - 单次调用的快照
   - 自定义统计维度
3. **定期同步**：每小时从 `stats-cache.json` 同步数据

## 数据结构更新

### 修改 StreamEvent 类型

```typescript
interface StreamEvent {
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;  // 新增
    cache_read_input_tokens?: number;      // 新增
  };
}
```

### 修改 UsageRecord

```typescript
interface UsageRecord {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens?: number;  // 新增
  cacheReadTokens?: number;    // 新增
  costUSD: number;
}
```

## 实施步骤

1. ✅ **当前方案可以继续使用**（已实现基本统计）
2. 🔧 **优化费用计算**：从 `response.total_cost_usd` 直接获取
3. 📊 **添加 CLI 统计读取器**：作为补充数据源
4. 🔀 **合并展示**：CLI 官方数据 + Telegram 自有数据

---

*调研时间: 2026-02-09*
