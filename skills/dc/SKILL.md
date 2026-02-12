---
name: dc
description: >
  Discord Bot 远程控制技能。通过本地 HTTP API 操作 Discord Bot 的所有功能：
  Task 管理、模型切换、发送消息、查看状态等。
  触发条件: "discord", "dc", "/dc", "bot command", "send discord",
  "task 管理", "切换模型", "bot api"。
version: 1.0.0
---

# Discord Bot API Skill

通过本地 RESTful API (`http://127.0.0.1:3456`) 操作 Discord Bot。
所有端点返回结构化 JSON，**不会**通过 Discord 输出（唯一例外：`POST /api/tasks/:id/message`）。

## API 端点一览

### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/status` | 全局状态 — Task 列表、默认 cwd/model |

### 模型
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/models` | 可用模型列表 + 当前全局默认 |
| PUT | `/api/models/default` | 设置全局默认模型 — `{"model": "..."}` |

### Task 管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 列出所有 Task（树形结构） |
| POST | `/api/tasks` | 创建 Task — `{"name": "...", "cwd?": "...", "forum?": "..."}` |
| GET | `/api/tasks/:threadId` | Task 详情 |
| PATCH | `/api/tasks/:threadId` | 更新 — `{"name?", "model?", "cwd?"}` |
| DELETE | `/api/tasks/:threadId` | 删除（归档 Thread） |
| POST | `/api/tasks/:threadId/archive` | 归档 |
| POST | `/api/tasks/:threadId/fork` | Fork — `{"branch": "..."}` |

### Task 内操作
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks/:threadId/message` | **发消息（唯一发 Discord 的）** — `{"text": "..."}` |
| POST | `/api/tasks/:threadId/clear` | 清空 Claude 上下文 |
| POST | `/api/tasks/:threadId/compact` | 压缩上下文 |
| POST | `/api/tasks/:threadId/rewind` | 撤销最后一轮 |
| POST | `/api/tasks/:threadId/stop` | 停止当前任务 |
| POST | `/api/tasks/:threadId/qdev` | 快速创建开发子任务 — `{"description": "..."}` |

### DevLog
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/devlogs` | 列出 DevLog — `?project=&date=&start=&end=` |
| POST | `/api/devlogs` | 创建 DevLog — `{"name", "date", "project", ...}` |
| GET | `/api/devlogs/:id` | DevLog 详情 |

### Idea
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ideas` | 列出 Idea — `?project=&status=` |
| POST | `/api/ideas` | 创建 Idea — `{"name", "project", "status?"}` |
| GET | `/api/ideas/:id` | Idea 详情 |
| PATCH | `/api/ideas/:id` | 更新 Idea — `{"name?", "status?", "project?"}` |

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

## 鉴权

除 `/api/health` 外，所有端点需要 Bearer token。Token 从项目 `.env` 文件的 `BOT_ACCESS_TOKEN` 获取。

**标准初始化（所有 API 调用前必须执行）：**

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"
```

之后所有请求（health 除外）携带 `-H "$AUTH"`。

## 常用操作示例

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"

# 健康检查（无需鉴权）
curl -s $API/api/health | jq

# 查看全局状态
curl -s -H "$AUTH" $API/api/status | jq

# 查看可用模型
curl -s -H "$AUTH" $API/api/models | jq

# 设置全局默认模型为 Opus
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"model": "claude-opus-4-6"}' $API/api/models/default | jq

# 列出所有 Task
curl -s -H "$AUTH" $API/api/tasks | jq

# 创建 Task
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "my-project", "cwd": "/home/jason/projects/my-project"}' $API/api/tasks | jq

# 查看 Task 详情
curl -s -H "$AUTH" $API/api/tasks/1234567890 | jq

# 更新 Task（改名 + 切换模型）
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "new-name", "model": "claude-opus-4-6"}' $API/api/tasks/1234567890 | jq

# 删除 Task（归档 Thread）
curl -s -X DELETE -H "$AUTH" $API/api/tasks/1234567890 | jq

# 归档 Task
curl -s -X POST -H "$AUTH" $API/api/tasks/1234567890/archive | jq

# Fork Task（创建 worktree 子 Task）
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"branch": "feature/new-branch"}' $API/api/tasks/1234567890/fork | jq

# 在 Task 中与 Claude 对话（消息会出现在 Discord Thread 中）
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text": "帮我分析一下项目结构"}' $API/api/tasks/1234567890/message | jq

# 清空 Claude 上下文
curl -s -X POST -H "$AUTH" $API/api/tasks/1234567890/clear | jq

# 压缩上下文
curl -s -X POST -H "$AUTH" $API/api/tasks/1234567890/compact | jq

# 撤销最后一轮对话
curl -s -X POST -H "$AUTH" $API/api/tasks/1234567890/rewind | jq

# 停止运行中的任务
curl -s -X POST -H "$AUTH" $API/api/tasks/1234567890/stop | jq
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
- `POST /api/tasks/:id/message` 是**唯一**会在 Discord 中产生输出的端点
- 所有其他端点仅通过 HTTP 响应返回数据，不会在 Discord 中产生任何消息
- Task ID 是 Discord Thread ID（string snowflake），不是数字
