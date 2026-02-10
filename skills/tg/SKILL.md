---
name: tg
description: >
  Telegram Bot 远程控制技能。通过本地 HTTP API 操作 Telegram Bot 的所有功能：
  Topic 管理、模型切换、发送消息、查看状态和用量等。
  触发条件: "telegram", "tg", "/tg", "bot command", "send telegram",
  "topic 管理", "切换模型", "bot api"。
version: 2.0.0
---

# Telegram Bot API Skill

通过本地 RESTful API (`http://127.0.0.1:3456`) 操作 Telegram Bot。
所有端点返回结构化 JSON，**不会**通过 Telegram 输出（唯一例外：`POST /api/topics/:id/message`）。

## API 端点一览

### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/status` | 全局状态 — Topic 列表、默认 cwd/model |
| GET | `/api/usage` | 今日 Token 用量 |
| GET | `/api/usage/:date` | 指定日期用量（`yesterday` 或 `YYYY-MM-DD`） |

### 模型
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/models` | 可用模型列表 + 当前全局默认 |
| PUT | `/api/models/default` | 设置全局默认模型 — `{"model": "..."}` |

### Topic 管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/topics` | 列出所有 Topic（树形结构） |
| POST | `/api/topics` | 创建 Topic — `{"name": "...", "cwd?": "..."}` |
| GET | `/api/topics/:topicId` | Topic 详情 |
| PATCH | `/api/topics/:topicId` | 更新 — `{"name?", "model?", "cwd?"}` |
| DELETE | `/api/topics/:topicId` | 删除（`?cascade=true` 级联删子） |
| POST | `/api/topics/:topicId/archive` | 归档 |
| POST | `/api/topics/:topicId/fork` | Fork — `{"branch": "..."}` |

### Topic 内操作
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/topics/:topicId/message` | **发消息（唯一发 Telegram 的）** — `{"text": "..."}` |
| POST | `/api/topics/:topicId/clear` | 清空 Claude 上下文 |
| POST | `/api/topics/:topicId/compact` | 压缩上下文 |
| POST | `/api/topics/:topicId/rewind` | 撤销最后一轮 |
| POST | `/api/topics/:topicId/stop` | 停止当前任务 |

## 响应格式

所有端点返回统一的 JSON 格式：

```json
{
  "ok": true,
  "data": { ... }
}
```

错误时：
```json
{
  "ok": false,
  "error": "错误描述"
}
```

## 常用操作示例

```bash
API="http://127.0.0.1:3456"

# 健康检查
curl -s $API/api/health | jq

# 查看全局状态
curl -s $API/api/status | jq

# 查看今日用量
curl -s $API/api/usage | jq

# 查看昨日用量
curl -s $API/api/usage/yesterday | jq

# 查看可用模型
curl -s $API/api/models | jq

# 设置全局默认模型为 Opus
curl -s -X PUT $API/api/models/default \
  -H 'Content-Type: application/json' \
  -d '{"model": "claude-opus-4-6"}' | jq

# 列出所有 Topic
curl -s $API/api/topics | jq

# 创建 Topic
curl -s -X POST $API/api/topics \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-project", "cwd": "/home/jason/projects/my-project"}' | jq

# 查看 Topic 详情
curl -s $API/api/topics/123 | jq

# 更新 Topic（改名 + 切换模型）
curl -s -X PATCH $API/api/topics/123 \
  -H 'Content-Type: application/json' \
  -d '{"name": "new-name", "model": "claude-opus-4-6"}' | jq

# 删除 Topic
curl -s -X DELETE $API/api/topics/123 | jq

# 级联删除（含子 Topic）
curl -s -X DELETE "$API/api/topics/123?cascade=true" | jq

# 归档 Topic
curl -s -X POST $API/api/topics/123/archive | jq

# Fork Topic（创建 worktree 子 Topic）
curl -s -X POST $API/api/topics/123/fork \
  -H 'Content-Type: application/json' \
  -d '{"branch": "feature/new-branch"}' | jq

# 在 Topic 中与 Claude 对话（消息会出现在 Telegram 会话中）
curl -s -X POST $API/api/topics/123/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "帮我分析一下项目结构"}' | jq

# 清空 Claude 上下文
curl -s -X POST $API/api/topics/123/clear | jq

# 压缩上下文
curl -s -X POST $API/api/topics/123/compact | jq

# 撤销最后一轮对话
curl -s -X POST $API/api/topics/123/rewind | jq

# 停止运行中的任务
curl -s -X POST $API/api/topics/123/stop | jq
```

## 可用模型 ID

| ID | 名称 |
|----|------|
| `claude-sonnet-4-5-20250929` | Sonnet 4.5 |
| `claude-opus-4-6` | Opus 4.6 |
| `claude-haiku-4-5-20251001` | Haiku 4.5 |

## 注意事项

- API 仅监听 `127.0.0.1`，只能本地访问
- 默认端口 3456，可通过 `.env` 中的 `API_PORT` 修改
- Bot 必须已通过 `/login` 授权才能使用大部分 API（`/api/health` 除外）
- `POST /api/topics/:id/message` 是**唯一**会在 Telegram 中产生输出的端点
- 所有其他端点仅通过 HTTP 响应返回数据，不会在 Telegram 中产生任何消息
