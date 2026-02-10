# Token 使用量统计功能

## 功能概述

自动追踪 Claude API 的 token 使用量和费用，提供按小时统计的详细报告，并每天早上 9 点自动发送昨日使用报告。

## 核心功能

### 1. 自动追踪

每次调用 Claude API 时，系统会自动记录：
- 输入 token 数量
- 输出 token 数量
- 使用的模型
- 预估费用（美元）
- 时间戳
- Session ID（可选）
- Topic ID（可选）

### 2. 费用计算

根据不同模型自动计算费用（价格基于 2026 年标准）：

| 模型 | 输入价格 | 输出价格 |
|------|---------|---------|
| Sonnet 4.5 | $3.0/M tokens | $15.0/M tokens |
| Opus 4.6 | $15.0/M tokens | $75.0/M tokens |
| Haiku 4.5 | $0.8/M tokens | $4.0/M tokens |

### 3. 统计查询

在 Telegram General 话题中使用 `/usage` 命令：

```
/usage              # 显示今日统计
/usage yesterday    # 显示昨日统计
/usage 2026-02-09   # 显示指定日期统计
```

### 4. 每日报告

每天早上 **9:00** 自动发送昨日使用报告到 General 话题，包含：
- 总请求数
- 总 token 数（输入/输出分开统计）
- 预估总费用
- 按小时的详细统计（带可视化进度条）

## 数据结构

### UsageRecord（使用记录）

```typescript
interface UsageRecord {
  timestamp: number;      // Unix 时间戳
  model: string;          // 模型 ID
  inputTokens: number;    // 输入 token 数
  outputTokens: number;   // 输出 token 数
  costUSD: number;        // 费用（美元）
  sessionId?: string;     // Claude session ID
  topicId?: number;       // Telegram topic ID
}
```

### DailyStats（每日统计）

```typescript
interface DailyStats {
  date: string;                    // YYYY-MM-DD
  inputTokens: number;             // 总输入 token
  outputTokens: number;            // 总输出 token
  totalTokens: number;             // 总 token
  costUSD: number;                 // 总费用
  requests: number;                // 总请求数
  hourlyBreakdown: HourlyStats[];  // 按小时分解
}
```

### HourlyStats（每小时统计）

```typescript
interface HourlyStats {
  hour: string;           // 'YYYY-MM-DD HH:00'
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  requests: number;
}
```

## 报告示例

```
📊 昨日使用报告
日期: 2026-02-08

总请求数: 42
总 Token 数: 1.2M
  输入: 850.5K
  输出: 349.5K
预估费用: $7.9425

按小时统计:
00:00 ░░░░░░░░░░ 12.3K ($0.0615)
01:00 ░░░░░░░░░░ 8.7K ($0.0435)
09:00 ████░░░░░░ 156.4K ($0.7820)
10:00 ██████░░░░ 234.1K ($1.1705)
14:00 ██████████ 389.2K ($1.9460)
15:00 ████████░░ 298.5K ($1.4925)
...
```

## 数据持久化

### 存储位置
`data/usage-stats.json`

### 存储格式
```json
{
  "records": [
    {
      "timestamp": 1738886400000,
      "model": "claude-sonnet-4-5-20250929",
      "inputTokens": 12500,
      "outputTokens": 4800,
      "costUSD": 0.1095,
      "sessionId": "session-abc123",
      "topicId": 42
    },
    ...
  ]
}
```

### 数据清理
- 自动保留最近 30 天的数据
- 每小时执行一次清理任务
- 使用防抖写入（1 秒延迟）避免频繁 I/O

## 实现细节

### 核心类：UsageTracker

位置：`telegram/bot/usage-tracker.ts`

主要方法：
- `track()` - 记录一次 API 调用
- `getDailyStats()` - 获取指定日期统计
- `getTodayStats()` - 获取今日统计
- `getYesterdayStats()` - 获取昨日统计
- `formatDailyReport()` - 格式化报告为 Markdown
- `cleanup()` - 清理旧数据

### 集成点

1. **handlers.ts**
   - 在 `sendChat()` 成功后调用 `usageTracker.track()`
   - 传入 response.usage 数据

2. **commands.ts**
   - 添加 `/usage` 命令处理器
   - 支持日期参数解析

3. **telegram.ts**
   - 初始化 UsageTracker 实例
   - 启动每日报告定时任务
   - 在清理任务中调用 `usageTracker.cleanup()`

### 定时任务实现

```typescript
private scheduleDailyReport(): void {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);

    // 如果已经过了今天 9 点，安排到明天 9 点
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    const delay = next.getTime() - now.getTime();
    this.dailyReportTimer = setTimeout(async () => {
      await this.sendDailyReport();
      scheduleNext(); // 递归安排下一次
    }, delay);
  };

  scheduleNext();
}
```

## 可视化

### Token 数量格式化
- < 1K: 显示原始数字
- 1K - 1M: 显示 K 单位（如 12.5K）
- >= 1M: 显示 M 单位（如 1.2M）

### 进度条
使用 Unicode 字符绘制：
- `█` - 填充部分
- `░` - 空白部分
- 默认宽度：10 个字符
- 按 token 数量比例计算填充

示例：
```
09:00 ████░░░░░░ 156.4K  # 40% 使用量
14:00 ██████████ 389.2K  # 100% 使用量（最高）
```

## 使用场景

### 个人开发者
- 监控日常 API 使用量
- 控制成本预算
- 分析使用模式

### 团队协作
- 统计团队总体使用量
- 按 Topic 区分项目成本
- 优化 prompt 效率

### 成本优化
- 识别高消耗时段
- 对比不同模型成本
- 调整使用策略

## 扩展性

### 添加新模型
修改 `MODEL_PRICING` 对象：

```typescript
const MODEL_PRICING = {
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  'new-model-id': { input: X.X, output: Y.Y },  // 添加新模型
} as const;
```

### 自定义报告时间
修改 `scheduleDailyReport()` 中的小时：

```typescript
next.setHours(9, 0, 0, 0);  // 改为其他小时，如 8, 10, 12
```

### 导出数据
直接读取 `data/usage-stats.json` 文件，可用于：
- 生成月度报告
- 数据可视化
- 成本分析

## 注意事项

1. **时区**
   - 当前使用系统本地时区
   - 报告时间基于服务器时间

2. **费用准确性**
   - 价格基于公开文档，可能有变动
   - 仅供参考，实际费用以 Claude 账单为准

3. **数据隐私**
   - 所有数据存储在本地
   - 不包含实际对话内容
   - 仅记录元数据（token 数、时间戳等）

4. **性能**
   - 使用防抖写入减少磁盘 I/O
   - 内存中维护数据，重启时从磁盘加载
   - 30 天自动清理避免数据膨胀

## 故障排查

### 报告未发送
- 检查 `AUTHORIZED_CHAT_ID` 是否配置
- 查看日志：`journalctl --user -u claude-telegram -f`
- 确认 Bot 有发送消息权限

### 统计数据不准确
- 检查 `data/usage-stats.json` 文件是否存在
- 确认文件权限可读写
- 查看是否有错误日志

### 费用计算错误
- 验证模型 ID 是否正确
- 检查 `MODEL_PRICING` 配置
- 查看 `response.total_cost_usd` 是否返回

---

*功能于 2026-02-09 实现*
