# Task g8t5 Implementation Summary

## 任务目标
废弃 messageHistory + 接入原始 session 数据 — 移除内存消息缓存；新增 GET /api/sessions/:id/conversation 流式读取 .jsonl；session-reader 解析工具

## 完成的工作

### 1. 移除内存 messageHistory 缓存

#### 修改的文件：

**discord/types/index.ts**
- 从 `Session` 接口中移除 `messageHistory` 字段
- 保留 `messageCount` 字段（用于统计）

**discord/db/repo/session-repo.ts**
- `rowToSession()`: 移除 `messageHistory: []` 初始化
- `rowToArchivedSession()`: 移除 JSON 解析和 messageHistory 恢复逻辑
- `sessionToParams()`: 移除从 `messageHistory.length` 计算 messageCount 的逻辑

**discord/bot/state.ts**
- `getOrCreateSession()`: 移除 `messageHistory: []` 初始化
- `updateSessionMessage()`:
  - 移除消息追加到 messageHistory 的逻辑
  - 改为简单的 `messageCount++`
  - 每次调用都持久化到数据库
- `rewindSession()`:
  - 移除从 messageHistory 数组中删除消息的逻辑
  - 改为 `messageCount -= 2`（减少一轮对话：user + assistant）

**discord/api/routes/tasks.ts**
- `getTask()`: 移除返回 `message_history` 字段
- `updateTask()`: 移除返回 `message_history` 字段

**discord/db/repo/__tests__/session-repo.test.ts**
- `makeSession()`: 移除 `messageHistory: []` 初始化
- 重写 `message history` 测试为 `message count` 测试
- 移除所有对 `messageHistory` 数组的断言

### 2. 新增流式 API 读取会话数据

#### 新增文件：

**discord/utils/session-reader.ts**
提供三个核心功能：

1. `findSessionJsonlFile(claudeProjectsDir, claudeSessionId)`
   - 从 `~/.claude/projects` 遍历查找包含指定 sessionId 的 .jsonl 文件
   - 返回文件绝对路径，找不到返回 null

2. `streamSessionEvents(jsonlPath, onEvent, onEnd, onError)`
   - 流式读取 .jsonl 文件
   - 逐行解析 JSON 事件
   - 通过回调函数返回每个事件

3. `readSessionEventsSync(jsonlPath)`
   - 同步读取所有事件（用于小文件或调试）

**discord/api/routes/sessions.ts**
实现 `GET /api/sessions/:id/conversation` 端点：

- 鉴权：检查 guildId
- 查询 `claude_sessions` 表获取 session 信息
- 使用 `findSessionJsonlFile()` 定位 .jsonl 文件
- 设置流式响应头（Content-Type: application/x-ndjson）
- 使用 `streamSessionEvents()` 逐行读取并返回事件

**discord/api/server.ts**
- 导入 `getSessionConversation` handler
- 注册路由 `GET /api/sessions/:id/conversation`

### 3. 测试和验证

- 所有修改的文件通过 `tsx --check` 语法检查
- 更新测试用例，移除 messageHistory 相关断言
- 核心功能语法正确，可以正常加载

## 架构变更

### 之前（内存缓存方式）
```
User Input → Bot → Session.messageHistory (内存数组，最多50条，截断到2000字符)
                → DB.sessions.message_count
```

### 之后（按需流式读取）
```
User Input → Bot → DB.sessions.message_count (仅计数)
                → ~/.claude/projects/xxx/*.jsonl (完整原始数据)

API Request → session-reader → 流式读取 .jsonl → 返回完整事件流
```

## 收益

1. **内存节省**：不再在内存中维护每个 session 的消息历史数组
2. **数据完整性**：从 .jsonl 文件读取完整原始数据，无截断
3. **性能优化**：
   - 写入：从 "INSERT + TRIM" → 单次 UPDATE messageCount
   - 读取：按需流式读取，不占用内存
4. **可扩展性**：可以读取完整的 tool 调用、usage、事件流等信息

## 兼容性

- 数据库 migration 006 和 007 已经完成 message_count 字段添加和 message_history 表删除
- 现有代码中所有 `.messageHistory.length` 引用已改为读取 `messageCount`
- API 响应不再包含 `message_history` 字段（前端需要调用新的 `/api/sessions/:id/conversation` 端点）

## 后续建议

1. 前端需要适配新的流式 API：`GET /api/sessions/:id/conversation`
2. 可以考虑添加 .jsonl 文件缓存机制（如果频繁读取同一个 session）
3. 可以扩展 API 支持过滤参数（如只返回 user/assistant 消息，跳过 system 事件）
