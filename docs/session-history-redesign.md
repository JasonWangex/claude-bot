# Session History 重设计

> 审计日期: 2025-02-13
> 状态: 待实施

## 背景

对 Discord Bot 的数据存储进行审计后发现，`message_history` 表存储的数据既不完整也未被真正消费，属于冗余写入。本文档记录审计结论和后续改进方向。

---

## 一、当前 messageHistory 可以去掉

### 现状

`message_history` 表为每个 session 存储最近 50 条 user/assistant 消息，每条 text 截断到 2000 字符。

**Schema:**
```sql
CREATE TABLE message_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  text        TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);
```

### 全部使用点

| 位置 | 用途 | 是否依赖 text 内容 |
|------|------|--------------------|
| `state.ts` rewindSession | 按 role 裁剪最后一轮消息 | 否，只读 role |
| `api/routes/status.ts` | 返回 `message_count` | 否，只读 `.length` |
| `api/routes/tasks.ts` | 返回 `message_count` | 否，只读 `.length` |
| `bot/commands/general.ts` /list | 显示 `(N msgs)` | 否，只读 `.length` |
| `bot/commands/task.ts` /task info | 显示 `Messages: N` | 否，只读 `.length` |

**关键发现：没有任何地方读取消息的 text 内容。** Claude Code CLI 自行管理完整对话历史（通过 `claudeSessionId` resume），Bot 侧的 messageHistory 是一份截断的、无消费者的冗余副本。

### 去掉后的影响

**需要改动：**
- `sessions` 表新增 `message_count INTEGER NOT NULL DEFAULT 0` 字段
- `state.ts` `updateSessionMessage()` 改为 `message_count++`
- `state.ts` `rewindSession()` 改为 `message_count -= 2`（去掉最后一轮 user+assistant）
- 5 处 `.messageHistory.length` 引用改为读 `message_count`
- `Session` 类型定义中 `messageHistory` 字段移除，加 `messageCount`
- 删除 `message_history` 表（migration 002）

**可以删除的代码：**
- `SessionRepository` 中 `getHistory`、`insertMessage`、`deleteHistory`、`trimHistory` 等 6 个 prepared statement
- `addMessageAndTrim()` 方法
- `save()` 中的事务（不再需要先删再插 history）
- `loadAllSessions()` 中的 history 查询
- `archived_sessions.message_history_json` 字段

**收益：**
- 每轮对话从 INSERT + TRIM 两次写操作 → 一次 UPDATE `message_count = message_count + 1`
- session save 从事务操作（DELETE history + INSERT N rows + UPSERT session）→ 单条 UPSERT
- 去掉"假保存"（截断 2000 字符的数据没有任何消费场景），不再造成"有存数据"的误导

---

## 二、后续改进：真正的会话交互日志

当前架构无法完整再现任何一个 session。如果未来需要会话回放/审计能力，需要一套新的设计。

### 当前丢失的数据

| 数据 | 说明 |
|------|------|
| 完整的用户消息 | 当前截断到 2000 字符 |
| Claude 完整响应 | 当前截断到 2000 字符 |
| Tool 调用输入/输出 | 完全不保存（Bash 命令、文件读写、搜索结果等） |
| 流式事件 | StreamEvent 链（thinking、compact、stall_warning）用后即弃 |
| Token 用量 | 只有最终汇总，无逐轮明细 |
| 图片附件 | 处理为 base64 后丢弃，不存档 |
| 系统 prompt | CLAUDE.md 内容和 append-system-prompt 不记录 |
| 模型/参数 | 模型只存 session 级别，不记录每轮使用的模型 |

### 最大的低成本改进

`/data/processes/*.jsonl` 文件包含**完整的 Claude 交互事件流**（每个 StreamEvent 一行 JSON），但当前在进程结束后立即删除（`executor.ts` cleanup）。

**只需停止删除这些文件**（或归档到按 session 组织的目录），就能以零开发成本保留完整的交互原始数据。后续可按需从 `.jsonl` 提取结构化数据入库。

### 未来方案草案

如果要做正式的交互日志系统，可以考虑：

```sql
-- 每轮 Claude 交互一条记录
CREATE TABLE interaction_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,       -- 第几轮对话
  user_text       TEXT,                    -- 完整用户输入
  assistant_text  TEXT,                    -- 完整 Claude 响应
  model           TEXT,                    -- 本轮使用的模型
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_cost_usd  REAL,
  tool_use_count  INTEGER,
  jsonl_path      TEXT,                    -- 原始事件流文件路径
  created_at      INTEGER NOT NULL
);
```

这样每轮对话有完整文本 + 原始 `.jsonl` 文件引用，既能快速查询，也能回放完整事件流。
