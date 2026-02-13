# Notion → SQLite 数据迁移指南

本文档描述如何将 Notion 中的 Goals、Ideas、DevLogs 数据迁移到本地 SQLite 数据库。

## 前置条件

1. Bot 正在运行（`npm run dev`）
2. Bot API 可访问（默认 `http://127.0.0.1:3456`）

## 初始化

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"
```

## 迁移步骤

### 1. 迁移 Goals

使用 Notion MCP 搜索所有 Goals，然后通过 Bot API 写入：

```bash
# 对每个 Goal，POST 到 /api/goals
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{
    "name": "<Goal Name>",
    "status": "<Active|Paused|Done|Abandoned|Idea>",
    "type": "<探索型|交付型>",
    "project": "<项目名>",
    "completion": "<完成标准>",
    "body": "<Notion 页面 Markdown 内容>"
  }' "$API/api/goals"
```

### 2. 迁移 Ideas

Ideas 实际上就是 Status=Idea 的 Goals 条目。迁移时通过 Ideas API：

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{
    "name": "<Idea Name>",
    "project": "<项目名>",
    "status": "Idea"
  }' "$API/api/ideas"
```

### 3. 迁移 DevLogs

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{
    "name": "<功能标题>",
    "date": "<yyyy-MM-dd>",
    "project": "<项目名>",
    "branch": "<分支名>",
    "summary": "<摘要>",
    "commits": <commit数>,
    "lines_changed": "<diff stat>",
    "goal": "<关联 Goal>",
    "content": "<Markdown 内容>"
  }' "$API/api/devlogs"
```

## 自动迁移脚本

推荐使用 Claude Code 执行自动迁移：

```
请帮我将 Notion 中的 Goals 和 DevLogs 迁移到本地 SQLite。

1. 用 notion-search 搜索 Goals Database (d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0) 中的所有条目
2. 对每个条目用 notion-fetch 获取完整内容
3. 用 curl POST 到 Bot API /api/goals 写入 SQLite
4. 同样处理 DevLogs Database (c1d6130c-fff9-47eb-a525-b53534a3c215)
```

迁移完成后，Skills 将只通过 Bot API 读写数据，不再依赖 Notion。
