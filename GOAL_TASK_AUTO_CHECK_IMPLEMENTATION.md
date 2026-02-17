# Goal Task 自动检查（3 问机制）实施总结

## 功能概述

当 Goal task 执行完成（收到 Stop hook 事件）时，自动向 Claude 发送 3 个检查问题，根据回答自动推进 pipeline 阶段或继续等待完成。

## 核心流程

```
Stop Hook
  ↓
checkGoalTaskCompletion (hooks.ts)
  ↓
orchestrator.checkTaskReadiness(goalId, taskId, channelId)
  ↓
buildReadinessCheckPrompt (根据 phase 选择 prompt)
  ↓
handleBackgroundChat (向 Claude 发送 3 问)
  ↓
readTaskCheckResponse (从 channel 读取 Claude 回答)
  ↓
parseCheckResponse (解析 yes/no 答案)
  ↓
handleTaskCheckResponse (根据回答推进 pipeline)
```

## 3 个检查问题

### Execute 阶段
1. 任务是否完成？（所有需求都已实现）
2. 自我审查是否通过？（代码质量符合标准，无明显问题）
3. 代码是否已提交？（已 git commit）

### Audit 阶段
1. 所有 audit 建议都已修复？
2. 代码已更新并提交？
3. 是否准备好 merge？

## 回答处理逻辑

### 全部通过（3 个 yes）

**Execute 阶段**:
- Complex task → 推进到 Audit 阶段（启动 Opus audit）
- Simple task → 直接标记为 completed

**Audit 阶段**:
- 标记为 completed
- 触发 merge 和清理流程

**Fix 阶段**:
- 准备重新审查（re-audit）

### 有未通过项（任意 no）

- 记录未通过的检查项到 `task.metadata.lastCheckIssues`
- 不发送通知，让 Claude 继续工作
- Claude 应该已在回答中说明原因并继续完成

## 已实现的文件

### 1. Orchestrator 方法 ✅

**文件**: `discord/orchestrator/index.ts`

新增方法：
- `checkTaskReadiness(goalId, taskId, channelId)` - 主入口
- `buildReadinessCheckPrompt(task, state, phase)` - 构建检查 prompt
- `readTaskCheckResponse(channelId, state, task)` - 读取 Claude 回答
- `parseCheckResponse(text)` - 解析 yes/no 答案
- `handleTaskCheckResponse(goalId, taskId, response, state, usage)` - 处理回答
- `startAuditPipeline(goalId, taskId, guildId, channelId, prevUsage)` - 启动 Audit

### 2. Hook 事件集成 ✅

**文件**: `discord/api/routes/hooks.ts`

在 `handleStop()` 中调用：
```typescript
// 触发 Goal task 检查（仅 goalId 存在时）
if (deps.orchestrator) {
  await checkGoalTaskCompletion(session, channelId, deps);
}
```

在 `checkGoalTaskCompletion()` 中：
```typescript
await deps.orchestrator.checkTaskReadiness(runningTask.goalId, runningTask.id, channelId);
```

### 3. 类型定义更新 ✅

**文件**: `discord/types/index.ts`

添加 `metadata` 字段到 `Task` 接口：
```typescript
export interface Task {
  // ... 现有字段
  metadata?: Record<string, any>;  // 用于存储扩展信息
}
```

### 4. Prompt 需求声明 ✅

**文件**: `discord/services/prompt-requirements.ts`

新增：
```typescript
{ key: 'orchestrator.task_readiness_check.execute', variables: ['TASK_DESCRIPTION', 'TASK_ID', 'TASK_LABEL', 'PIPELINE_PHASE'], optional: true },
{ key: 'orchestrator.task_readiness_check.audit',   variables: ['TASK_DESCRIPTION', 'TASK_ID', 'TASK_LABEL', 'PIPELINE_PHASE'], optional: true },
```

### 5. Prompt 模板 SQL ✅

**文件**: `scripts/seed-task-readiness-prompts.sql`

包含两个 prompt 模板：
- `orchestrator.task_readiness_check.execute`
- `orchestrator.task_readiness_check.audit`

### 6. Seed 脚本 ✅

**文件**: `scripts/seed-prompts.sh`

执行 SQL 插入 prompt 模板到数据库

## 启用步骤

### 1. 插入 Prompt 模板到数据库

```bash
cd /home/jason/projects/claude-bot
./scripts/seed-prompts.sh
```

**验证**:
```bash
sqlite3 data/bot.db "SELECT key, name FROM prompt_configs WHERE key LIKE '%readiness_check%'"
```

### 2. 重启服务

```bash
./deploy.sh restart
```

## 测试验证

### 1. 基本流程测试

```bash
# 1. 创建一个 goal 并启动 drive
# 2. 观察任务执行完成后的自动检查

# 监控日志
tail -f logs/discord-bot.log | grep -E "checkTaskReadiness|parseCheckResponse"
```

**预期行为**:
- Stop hook 触发后，Claude 收到 3 个检查问题
- Claude 回答 yes/no
- 全部 yes → 自动推进到下一阶段或标记完成
- 有 no → 记录到 metadata，Claude 继续工作

### 2. 检查 metadata 记录

```bash
sqlite3 data/bot.db "
  SELECT id, description, status, pipeline_phase,
         json_extract(feedback_json, '$.type') as feedback_type
  FROM tasks
  WHERE goal_id IS NOT NULL
  ORDER BY dispatched_at DESC LIMIT 10
"
```

**注意**: metadata 字段目前未持久化到数据库（仅在内存的 GoalDriveState 中）

### 3. Discord 消息验证

**Execute 阶段 → Audit**:
- 应该看到："✅ **任务自检通过，推进到 Audit 阶段:**"
- 应该看到："[Pipeline] {taskId}: 进入 Opus Audit 阶段"

**Audit 完成**:
- 应该看到："Completed: {taskLabel} - {description}"

## 回答解析方式

### 方法 1: Feedback 文件（优先）

Claude 可以写入结构化文件：
```json
// feedback/{taskId}-readiness.json
{
  "completed": true,
  "audited": true,
  "committed": true
}
```

### 方法 2: Discord 消息解析（fallback）

从最后一条 Bot 消息中提取：
```
1. yes
2. yes
3. no
```

支持格式：
- 代码块内：\`\`\`\n1. yes\n2. yes\n3. no\n\`\`\`
- 普通文本：直接匹配行

## 自动推进逻辑

### Execute → Audit

```typescript
if (currentPhase === 'execute' && allYes) {
  if (task.complexity === 'complex') {
    // 启动 Opus audit pipeline
    await startAuditPipeline(goalId, taskId, guildId, channelId, usage);
  } else {
    // Simple task 直接完成
    await onTaskCompleted(goalId, taskId, usage);
  }
}
```

### Audit → Completed

```typescript
if (currentPhase === 'audit' && allYes) {
  await onTaskCompleted(goalId, taskId, usage);
}
```

## 边界情况处理

### 1. Prompt 模板缺失
- `buildReadinessCheckPrompt()` 返回 null
- 记录 warn 日志，跳过自动检查

### 2. 解析失败
- `parseCheckResponse()` 返回 null
- 记录 warn 日志，跳过自动推进
- Claude 继续工作，用户可以手动干预

### 3. Task 状态不匹配
- 检查 `task.status === 'running'`
- 非 running 状态跳过检查

### 4. 非 Goal Task
- `checkGoalTaskCompletion()` 检查 `task.goalId`
- 独立任务（如 qdev）不触发自动检查

### 5. Channel 读取失败
- Fallback 到 feedback 文件方式
- 如果两种方式都失败，跳过自动检查

## 性能考虑

- **额外 API 调用**: 每次 Stop hook 触发一次 Discord API (fetch messages)
- **Token 消耗**: 每次检查约 100-200 tokens（prompt + response）
- **延迟**: Discord API 调用 + Claude 回答约 1-3 秒

## 可配置项

### 启用/禁用自动检查

可以通过环境变量或配置文件控制：

```typescript
// discord/api/routes/hooks.ts
if (process.env.AUTO_CHECK_ENABLED !== 'false' && deps.orchestrator) {
  await checkGoalTaskCompletion(session, channelId, deps);
}
```

### 自定义 Prompt

修改数据库中的 prompt 模板：
```bash
sqlite3 data/bot.db
```

```sql
UPDATE prompt_configs
SET template = '你的自定义 prompt...'
WHERE key = 'orchestrator.task_readiness_check.execute';
```

## 调试技巧

### 1. 查看 Claude 的原始回答

```bash
# 读取最后一条 bot 消息
# 使用 Discord API 或直接在 Discord 查看
```

### 2. 手动触发检查（测试用）

在 orchestrator 中暴露公开方法：
```typescript
// 通过 API 手动触发
POST /api/goals/{goalId}/tasks/{taskId}/check-readiness
```

### 3. 查看 metadata

```typescript
// 在 GoalDriveState 中查看
const state = await orchestrator.getState(goalId);
const task = state.tasks.find(t => t.id === taskId);
console.log(task.metadata);
```

## 后续优化

### 1. Metadata 持久化

添加 `metadata` 字段到 `tasks` 表：
```sql
ALTER TABLE tasks ADD COLUMN metadata_json TEXT;
```

### 2. 更智能的触发条件

- 仅在 pipeline 关键阶段检查（execute → audit, audit → complete）
- 跳过 fix 阶段的检查（已在 auditFixLoop 中处理）

### 3. 检查历史记录

记录每次检查的结果和时间：
```typescript
task.metadata.checkHistory = [
  { timestamp: Date.now(), result: { completed: true, audited: true, committed: false } }
];
```

### 4. 自适应检查频率

- 第一次 Stop 不检查，给 Claude 更多时间
- 第二次 Stop 才触发检查

### 5. 支持更多 Phase

添加 `fix` 和 `plan` 阶段的检查 prompt

---

## 文件清单

### 新增文件
1. `scripts/seed-task-readiness-prompts.sql` - Prompt SQL
2. `scripts/seed-prompts.sh` - Seed 脚本
3. `GOAL_TASK_AUTO_CHECK_IMPLEMENTATION.md` - 本文档

### 修改文件
1. `discord/orchestrator/index.ts` - 添加 checkTaskReadiness 等方法
2. `discord/api/routes/hooks.ts` - 启用自动检查调用
3. `discord/types/index.ts` - 添加 metadata 字段
4. `discord/services/prompt-requirements.ts` - 添加 prompt 声明

---

## 总结

Goal Task 自动检查（3 问机制）已完整实现，核心功能包括：

✅ Stop hook 触发自动检查
✅ 根据 phase 选择不同的检查 prompt
✅ 解析 Claude 的 yes/no 回答
✅ 全部通过时自动推进 pipeline
✅ 有未通过项时记录并让 Claude 继续工作
✅ 支持 Execute 和 Audit 两个阶段
✅ Prompt 模板可配置

**启用**: 运行 `./scripts/seed-prompts.sh` 并重启服务即可。
