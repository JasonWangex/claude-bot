# Claude Session 中间状态管理实施总结

## 已完成的实现

### 1. 数据库扩展 ✅

**文件**: `discord/db/migrations/013_add_session_states.ts`

- 扩展 `claude_sessions` 表的 `status` 字段：`'active' | 'waiting' | 'idle' | 'closed'`
- 新增字段：
  - `last_activity_at`: 最后活动时间（用于超时监控）
  - `last_usage_json`: 最后一次执行的 token/cost 数据（JSON string）
- 新增索引：`idx_claude_sessions_status_activity`

**状态定义**:
- `active`: Claude 正在执行（SessionStart 设置）
- `waiting`: 等待用户输入（Notification 设置）
- `idle`: 当前轮次完成，空闲状态（Stop 设置）
- `closed`: session 已结束（SessionEnd 设置）

### 2. 类型定义更新 ✅

**文件**:
- `discord/types/index.ts`: 更新 `ClaudeSession` 接口
- `discord/types/db.ts`: 更新 `ClaudeSessionRow` 接口

### 3. Repository 更新 ✅

**文件**: `discord/db/repo/claude-session-repo.ts`

- 更新 `rowToClaudeSession()` 和 `claudeSessionToParams()` 转换函数
- 更新 `upsert` SQL 语句支持新字段

### 4. Hook 事件处理核心逻辑 ✅

**文件**: `discord/api/routes/hooks.ts`

**SessionStart**:
```typescript
session.status = 'active';
session.lastActivityAt = Date.now();
await claudeSessionRepo.save(session);
```

**Notification**:
```typescript
session.status = 'waiting';
session.lastActivityAt = Date.now();
await claudeSessionRepo.save(session);

// 延迟 5 秒发送等待消息
setTimeout(async () => {
  const latestSession = await claudeSessionRepo.get(session.id);
  if (latestSession?.status === 'waiting') {
    const msgId = await mq.send(channelId, '@everyone 等待输入 (tokens, %)', ...);
    stateManager.setWaitingMessageId(channelId, msgId);
  }
}, 5000);
```

**Stop**:
```typescript
session.status = 'idle';
session.lastActivityAt = Date.now();
session.lastUsageJson = JSON.stringify(metadata);
await claudeSessionRepo.save(session);

// 取消待发的等待消息
const waitingMsgId = stateManager.getWaitingMessageId(channelId);
if (waitingMsgId) {
  await mq.delete(channelId, waitingMsgId);
  stateManager.cancelWaitingMessage(channelId);
}

// 幂等检查：10秒内不重复发送
const lastStopTime = stateManager.getLastStopTime(channelId);
if (lastStopTime && (now - lastStopTime) < 10000) {
  return; // 跳过重复消息
}
stateManager.setLastStopTime(channelId, now);

// 发送完成消息
await mq.send(channelId, '@everyone Done | 时长 | tokens | cost', ...);
```

**SessionEnd**:
```typescript
session.status = 'closed';
session.closedAt = Date.now();
await claudeSessionRepo.save(session);

// 清除追踪状态
stateManager.clearSessionTracking(channelId);

// 异常退出处理
if (reason === 'other') {
  // 标记 running task 为 failed
}
```

### 5. 状态管理扩展 ✅

**文件**: `discord/bot/state.ts`

新增 `SessionTracking` 接口和方法：
- `setWaitingMessageId(channelId, msgId)`: 设置等待消息 ID
- `getWaitingMessageId(channelId)`: 获取等待消息 ID
- `setWaitingTimer(channelId, timer)`: 设置等待消息定时器
- `cancelWaitingMessage(channelId)`: 取消等待消息（清除定时器和消息ID）
- `setLastStopTime(channelId, timestamp)`: 设置最后一次 Stop 时间
- `getLastStopTime(channelId)`: 获取最后一次 Stop 时间
- `clearSessionTracking(channelId)`: 清除所有追踪状态

### 6. 用户交互时取消等待消息 ✅

**文件**:
- `discord/bot/handlers.ts`: `handleText()` 入口处调用 `cancelWaitingMessage()`
- `discord/bot/discord.ts`: `handleButton()` 入口处调用 `cancelWaitingMessage()`

### 7. Session 超时监控服务 ✅

**文件**: `discord/sync/session-timeout-service.ts`

- 每 5 分钟检查一次
- 自动关闭超过 30 分钟无活动的 `waiting`/`idle` 状态 session

### 8. Hook URL 配置 ✅

**文件**: `discord/claude/executor.ts`

在 `buildArgs()` 方法中添加：
```typescript
if (process.env.CLAUDE_HOOK_ENABLED === 'true') {
  const apiPort = process.env.API_PORT || '3456';
  args.push('--hook-url', `http://localhost:${apiPort}/api/internal/hooks/session-event`);
}
```

---

## 启用步骤

### 1. 运行数据库 migration

```bash
# 检查当前 schema 版本
sqlite3 data/bot.db "SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1"

# Migration 会在下次启动时自动执行
# 或手动触发
npm run migrate
```

### 2. 配置环境变量

在 `.env` 文件中添加：
```bash
CLAUDE_HOOK_ENABLED=true
API_PORT=3456
```

### 3. 启动超时监控服务

在 `discord/bot/discord.ts` 或主入口文件中初始化：

```typescript
import { SessionTimeoutService } from '../sync/session-timeout-service.js';

// 在 Bot 启动时
const timeoutService = new SessionTimeoutService(claudeSessionRepo);
timeoutService.start();

// 在 Bot 关闭时
process.on('SIGINT', () => {
  timeoutService.stop();
  // ... 其他清理
});
```

### 4. 重启服务

```bash
./deploy.sh restart
```

---

## 测试验证

### 1. 基本状态转换

```bash
# 1. 在 Discord channel 发送消息
# 2. 观察数据库状态变化
sqlite3 data/bot.db "
  SELECT id, claude_session_id, status, last_activity_at,
         datetime(last_activity_at/1000, 'unixepoch') as last_activity
  FROM claude_sessions
  ORDER BY created_at DESC LIMIT 5
"
```

**预期结果**:
- 发送消息后：`status = 'active'`
- Claude 等待输入时：`status = 'waiting'`（5秒后出现蓝色等待消息）
- 用户输入新消息：等待消息自动删除
- 执行完成后：`status = 'idle'`（出现绿色 Done 消息）
- 10秒内多次 Stop：只发一次 Done 消息

### 2. 等待消息测试

```bash
# 1. 触发 Claude 执行
# 2. 等待 Claude 询问问题（AskUserQuestion）
# 3. 观察：5秒后应出现蓝色等待消息
# 4. 发送回复
# 5. 观察：等待消息应该被删除
```

### 3. 幂等测试

```bash
# 监控日志
tail -f logs/discord-bot.log | grep -E "Hook event|Stop"

# 预期：10秒内多次 Stop 事件，只发送一次 Done 消息
```

### 4. 超时监控测试

```bash
# 1. 创建一个 waiting 状态的 session
# 2. 等待 30+ 分钟
# 3. 检查状态应该变为 'closed'

sqlite3 data/bot.db "
  SELECT id, status, closed_at,
         datetime(last_activity_at/1000, 'unixepoch') as last_activity
  FROM claude_sessions
  WHERE status = 'closed'
  ORDER BY closed_at DESC LIMIT 5
"
```

---

## 未实现的功能（TODO）

### Goal Task 自动检查

**计划中的功能**:
- Stop 事件时向 Claude 发送 3 个问题：
  1. 任务是否完成？
  2. 自我审查是否通过？
  3. 代码是否已提交？
- 根据回答自动推进 pipeline 阶段

**需要实现**:
1. 在 `discord/orchestrator/index.ts` 中添加 `checkTaskReadiness()` 方法
2. 创建 prompt 模板（`orchestrator.task_readiness_check.execute` 和 `audit`）
3. 实现回答解析和处理逻辑

**相关代码位置**:
- `discord/api/routes/hooks.ts:326-353` - `checkGoalTaskCompletion()` 已预留
- 需要在 orchestrator 中实现完整逻辑

---

## 监控和调试

### 查看 Hook 事件日志

```bash
tail -f logs/discord-bot.log | grep "\[Hook\]"
```

### 检查 session 状态分布

```bash
sqlite3 data/bot.db "
  SELECT status, COUNT(*) as count
  FROM claude_sessions
  GROUP BY status
"
```

### 检查超时 session

```bash
sqlite3 data/bot.db "
  SELECT id, status,
         datetime(last_activity_at/1000, 'unixepoch') as last_activity,
         (strftime('%s', 'now') * 1000 - last_activity_at) / 60000 as minutes_idle
  FROM claude_sessions
  WHERE status IN ('waiting', 'idle')
    AND last_activity_at IS NOT NULL
  ORDER BY last_activity_at ASC
"
```

---

## 边界情况处理

### 1. Hook 事件丢失
- **缓解**: Claude CLI 内置重试
- **兜底**: 30分钟超时自动关闭

### 2. 多个 Session 在同一 Channel
- **策略**: `getActiveByChannel` 按 `created_at DESC` 取最新
- **Hook 处理**: 通过 `claudeSessionId` 精确匹配

### 3. Hook 事件乱序
- **解决**: 使用 `last_activity_at` 时间戳，忽略早于当前记录的事件

### 4. 等待消息与用户交互冲突
- **解决**: 延迟 5 秒发送，新交互时立即取消

### 5. Stop 消息重复
- **解决**: 10 秒幂等窗口去重

---

## 文件清单

### 新增文件
1. `discord/db/migrations/013_add_session_states.ts`
2. `discord/sync/session-timeout-service.ts`
3. `SESSION_STATES_IMPLEMENTATION.md`（本文档）

### 修改文件
1. `discord/types/index.ts` - ClaudeSession 接口
2. `discord/types/db.ts` - ClaudeSessionRow 接口
3. `discord/db/repo/claude-session-repo.ts` - Repository 实现
4. `discord/api/routes/hooks.ts` - Hook 事件处理核心逻辑
5. `discord/bot/state.ts` - 状态追踪管理
6. `discord/bot/handlers.ts` - 取消等待消息
7. `discord/bot/discord.ts` - 按钮交互取消等待消息
8. `discord/claude/executor.ts` - Hook URL 配置

---

## 性能考虑

- **内存开销**: SessionTracking Map 仅存储活跃 channel 的临时状态（定时器 + 消息ID）
- **数据库写入**: 每个 hook 事件 1 次写入（`claude_sessions` 表）
- **消息队列**: 等待消息和 Done 消息都使用高优先级，立即发送
- **超时检查**: 每 5 分钟全表扫描（可接受，session 数量通常不多）

---

## 后续优化建议

1. **智能检查时机**: 通过 transcript 分析判断是否真的需要 3 问检查
2. **渐进式提示**: 第一次 idle 不检查，第二次才提示
3. **检查结果记忆**: 记录用户的回答模式，减少重复询问
4. **更精确的超时查询**: 在 Repository 中添加按状态和时间范围查询的方法
