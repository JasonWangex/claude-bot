# Resume Session 修复 — 讨论存档

## 问题背景

两个场景导致 qdev 任务无法 resume：
1. **bot 崩溃**：Claude 子进程被一起杀死，background chat 丢失
2. **Claude 进程异常退出**（超时/信号/非0退出码）：`chat()` 抛异常，`setSessionClaudeId()` 未被调用，旧表不更新

---

## 数据库表结构现状

### 有效表
| 表名 | 用途 | 实际状态 |
|------|------|---------|
| `_deprecated_sessions` | channel ↔ claudeSessionId 绑定 | 命名废弃但仍是主力，StateManager 启动时从这里加载内存 |
| `_deprecated_archived_sessions` | 归档 sessions | 同上 |
| `channels` | 新 channel 元数据 | 写入完整，但 load() 不读 |
| `claude_sessions` | Claude CLI session 实体 | 通过 onSessionSync 实时写入，但 load() 不读 |
| `channel_session_links` | channel 与 session 多对多关联 | 建了表但**从未有代码写入** |

### 核心问题

`StateManager.load()` 只从 `_deprecated_sessions` 加载内存 Map，新表数据加载后直接丢弃（有 TODO 注释）。

`claude_sessions` 表通过 `onSessionSync` 在进程运行期间实时写入，即使 bot 崩溃前也有最新的 `claudeSessionId`，但重启后这个信息被忽略。

### claudeSessionId 写入时机对比

| 表 | 写入时机 | 崩溃场景下是否有值 |
|----|---------|-----------------|
| `_deprecated_sessions` | `chat()` 成功返回后 | ❌ chat() 未返回就丢失 |
| `claude_sessions` | 进程运行中首次出现 session_id（实时） | ✅ 有 |

---

## 用户决策：去掉内存 Map，改为直接查 SQLite

**理由**：
- `better-sqlite3` 同步查询 0.1-1ms，Discord bot 完全足够
- 消除内存状态与 DB 不一致的整类 bug
- load() 复杂的启动逻辑、旧表/新表问题全部消失

**障碍评估**：
- `getAllSessions`、`findSessionHolder`、`getRootSession`、`getChildSessions`、`getOccupiedWorkDirs`、`clearChildParentRefs`、`cleanup` 等遍历操作均可直接用 SQL 表达
- `sessionIds`（按模型分槽：`{ sonnet?: string; opus?: string }`）字段目前只在旧表，新表没有 → **用户尚未回答是否保留**

---

## 完整方案（基于"只建新逻辑，不碰旧数据"原则）

### 方案 A：修复新表体系（保留内存 Map）

共 8 处修改，6 个文件：

1. **`claude-session-repo.ts`**：新增 `linkToChannel(channelId, claudeSessionUuid, linkedAt)` 方法，写入 `channel_session_links` 表
2. **`session-sync-service.ts`**：`syncSession()` 创建/更新记录后同步写 `channel_session_links`
3. **`state.ts` — `persistSession()`**：写入 `channel_session_links`
4. **`state.ts` — `setSessionClaudeId()`**：删除未 await 的 `.then()` 竞态块（由 persistSession 统一处理）
5. **`state.ts` — `load()`** ★核心：从 `channels + claude_sessions` 重建内存 Map，取每个 channel 最新的 active session
6. **`task-repo.ts`**：新增 `findPendingDispatched()` 查询 dispatched 但未完成的独立任务
7. **`discord.ts`**：启动时调用 `recoverDispatchedTasks()`，对没有 claudeSessionId 的 dispatched task 重触发 background chat（3s 延迟）
8. **`dev.ts`**：slash command qdev 补存 task 到数据库（与 API 路由保持一致）

**load() 新逻辑核心**：
```typescript
// 从 claude_sessions 按 channelId 建最新 active session 索引
// 按 createdAt 取最新，跳过 status=closed 的
// 重建 Session 对象写入内存 Map
// 回退：新表为空时从旧表加载
```

### 方案 B：去掉内存 Map，全部直接查 SQLite（用户倾向）

StateManager 的所有方法改为直接查 DB：
- `getSession()` → `SELECT FROM channels WHERE id = ?` + `claude_sessions`
- `getOrCreateSession()` → INSERT OR IGNORE + SELECT
- 遍历操作全部改 SQL
- 写操作去掉内存更新，只写 DB

**待确认**：`sessionIds`（按模型分槽）字段是否保留，决定是否需要给 `claude_sessions` 加列。

---

## 关键文件路径

```
discord/bot/state.ts                          — StateManager（内存 Map 主体）
discord/bot/handlers.ts:481                   — setSessionClaudeId 调用点
discord/claude/executor.ts:334-344            — onSessionSync 首次触发
discord/claude/executor.ts:472-481            — onSessionSync 进程退出触发
discord/sync/session-sync-service.ts          — syncSession 实现
discord/db/repo/claude-session-repo.ts        — claude_sessions CRUD
discord/db/repo/channel-repo.ts               — channels CRUD
discord/db/repo/session-repo.ts               — _deprecated_sessions CRUD
discord/db/repo/task-repo.ts                  — tasks CRUD
discord/api/routes/qdev.ts                    — API 路由 qdev（已有 task 保存）
discord/bot/commands/dev.ts                   — slash command qdev（缺 task 保存）
discord/bot/discord.ts                        — launch() 启动逻辑
discord/db/migrations/001_create_schema.ts    — 表结构定义
```

---

## 下一步

确认方向后开始实现：
1. 方案 A（修复新表体系，保留内存 Map）— 改动较小，风险低
2. 方案 B（去掉内存 Map）— 需先确认 `sessionIds` 字段去留
