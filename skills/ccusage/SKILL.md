---
name: ccusage
description: >
  Claude Code 用量查询。通过 ccusage 工具获取 token 用量和费用，
  输出 IM 友好的格式化消息。支持 daily（每日）和 blocks（计费窗口）两种报告。
  触发条件: "ccusage", "用量", "usage", "token 用量", "费用"。
version: 1.0.0
---

# Claude Code 用量查询

通过 `ccusage` CLI 工具查询 Claude Code 的本地 token 用量和预估费用，并格式化为 IM 友好的消息。

## 参数解析

用户输入 `{{SKILL_ARGS}}`，按以下规则解析：

| 输入 | 动作 |
|------|------|
| *(空)* | 执行 **daily（今日）+ blocks（当前窗口）** |
| `daily` | 仅执行 daily 报告 |
| `blocks` | 仅执行 blocks 报告 |
| `daily 7` 或 `daily 7d` | 最近 7 天的 daily 报告 |
| `monthly` | 本月的 monthly 报告 |

## 执行步骤

### 1. 运行 ccusage 命令

根据解析结果执行对应命令。**所有命令加 `--json` 获取结构化数据**。

**Daily 报告（默认查今日）：**
```bash
npx -y ccusage@latest daily --json --since <YYYYMMDD>
```
- 默认 `--since` 为今天日期
- 如果用户指定了天数 N，`--since` 设为 N 天前的日期

**Blocks 报告（当前计费窗口）：**
```bash
npx -y ccusage@latest blocks --json --active
```

**Monthly 报告：**
```bash
npx -y ccusage@latest monthly --json --since <本月1日YYYYMMDD>
```

### 2. 解析 JSON 输出

**Daily JSON 结构：**
```json
{
  "daily": [
    {
      "date": "YYYY-MM-DD",
      "models": ["claude-opus-4-6"],
      "inputTokens": 12345,
      "outputTokens": 6789,
      "cacheCreationTokens": 100,
      "cacheReadTokens": 50,
      "totalTokens": 19284,
      "costUSD": 0.15
    }
  ],
  "totals": {
    "inputTokens": 12345,
    "outputTokens": 6789,
    "totalTokens": 19284,
    "totalCost": 0.15
  }
}
```

**Blocks JSON 结构：**
```json
{
  "type": "blocks",
  "data": [
    {
      "blockStart": "ISO timestamp",
      "blockEnd": "ISO timestamp",
      "isActive": true,
      "timeRemaining": "2h 30m",
      "inputTokens": 100000,
      "outputTokens": 50000,
      "totalTokens": 150000,
      "costUSD": 5.50,
      "burnRate": 1234.5,
      "projectedTotal": 500000,
      "projectedCost": 12.50
    }
  ],
  "summary": { ... }
}
```

### 3. 格式化 IM 消息

将数据格式化为简洁易读的消息。**直接输出纯文本**，不要用代码块包裹。

**默认模式（daily + blocks）输出模板：**

```
📊 Claude Code 用量报告

📅 今日 (YYYY-MM-DD)
• 输入: 123.4K tokens
• 输出: 56.7K tokens
• 缓存: 读 89.0K / 写 12.3K
• 费用: $1.23
• 模型: Opus 4.6, Sonnet 4.5

⏱️ 当前计费窗口
• 窗口: HH:MM ~ HH:MM（剩余 Xh Xm）
• Token: 150.0K（速率 1.2K/min）
• 费用: $5.50（预计 $12.50）
```

**多日 daily 输出模板：**

```
📊 Claude Code 用量报告（最近 N 天）

📅 2025-02-10  $1.23  45.6K tokens
📅 2025-02-09  $0.89  32.1K tokens
📅 2025-02-08  $2.15  78.9K tokens
─────────────────────
合计  $4.27  156.6K tokens
```

### 格式化规则

- **Token 数量**: 用 K（千）为单位，保留 1 位小数。如 `12345` → `12.3K`，小于 1000 直接显示数字
- **费用**: 保留 2 位小数，加 `$` 前缀
- **模型名**: 简化显示（`claude-opus-4-6` → `Opus 4.6`，`claude-sonnet-4-5-20250929` → `Sonnet 4.5`，`claude-haiku-4-5-20251001` → `Haiku 4.5`）
- **时间**: 24 小时制，只显示时分
- **如果某项数据为 0 或缺失，省略该行**

## 注意事项

- `npx -y` 确保自动确认安装，不需要用户交互
- 如果命令执行失败，输出简洁的错误提示
- npx 首次运行可能较慢（需要下载），这是正常的
- 所有数据都是本地计算的，不会发送到外部

---

**现在请根据用户输入执行查询并输出格式化结果。用户输入：{{SKILL_ARGS}}**
