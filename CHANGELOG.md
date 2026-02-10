# Changelog

## [Unreleased] - 2026-02-09

### Added
- **Token 使用统计功能**
  - 自动追踪每次 Claude API 调用的 token 使用量和费用
  - `/usage` 命令查询按小时统计（支持今日/昨日/指定日期）
  - 每天早上 9:00 自动发送昨日使用报告到 General 话题
  - 支持多模型定价（Sonnet 4.5 / Opus 4.6 / Haiku 4.5）
  - 数据持久化存储（保留 30 天）
  - 可视化进度条显示各小时使用量分布
  - 详细文档：`docs/USAGE_TRACKING.md`

### Changed
- 更新 `/help` 命令，添加 `/usage` 说明
- `MessageHandler` 构造函数新增 `UsageTracker` 参数
- `CommandHandler` 构造函数新增 `UsageTracker` 参数
- `TelegramBot` 集成使用统计追踪器和每日报告定时任务

### Files Modified
- `telegram/bot/usage-tracker.ts` - 新增
- `telegram/bot/handlers.ts` - 集成 token 追踪
- `telegram/bot/commands.ts` - 新增 `/usage` 命令
- `telegram/bot/telegram.ts` - 集成追踪器和定时任务
- `docs/CLAUDE.md` - 更新文档
- `docs/USAGE_TRACKING.md` - 新增功能文档

## Features Summary

### Token Usage Tracking
- **Automatic Tracking**: Records input/output tokens, model, cost for every API call
- **Hourly Statistics**: Detailed breakdown by hour with visualization
- **Cost Calculation**: Multi-model pricing (Sonnet/Opus/Haiku)
- **Daily Reports**: Automated 9:00 AM reports with yesterday's stats
- **Data Persistence**: 30-day retention with automatic cleanup
- **Query Interface**: `/usage [yesterday|YYYY-MM-DD]` command

### Technical Implementation
- **UsageTracker Class**: Core statistics engine
- **Integration Points**:
  - `handlers.ts`: Track on API response
  - `commands.ts`: `/usage` command handler
  - `telegram.ts`: Daily report scheduler
- **Data Format**: JSON storage at `data/usage-stats.json`
- **Performance**: Debounced writes (1s), hourly cleanup

### Example Report
```
📊 昨日使用报告
日期: 2026-02-08

总请求数: 42
总 Token 数: 1.2M
  输入: 850.5K
  输出: 349.5K
预估费用: $7.9425

按小时统计:
09:00 ████░░░░░░ 156.4K ($0.7820)
14:00 ██████████ 389.2K ($1.9460)
...
```

---

*Generated: 2026-02-09*
