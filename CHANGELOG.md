# Changelog

## [Unreleased] - 2026-02-10

### Removed
- **内置 Token 使用统计功能** — 迁移到独立的 `ccusage` skill
  - 移除 `UsageReader`、`CLIStatsReader` 类
  - 移除 `/usage` 命令和 API 端点 (`/api/usage`)
  - 移除每日使用报告定时任务
  - 用量查询改用 `ccusage` skill（基于 ccusage CLI 工具）
