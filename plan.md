# Goal Orchestrator 架构设计

## 概述

在 Telegram Bot 中新增 **GoalOrchestrator** 模块，作为持续运行的调度引擎，自动将 Notion Goal 的子任务派发到独立的 worktree/topic 中并行执行，完成后自动合并到 goal 分支，全程只在需要用户决策时才打断用户。

## 核心设计决策

### 1. Goal 分支策略

```
main
 └── goal/<goal-name>          ← Orchestrator 自动创建
      ├── feat/subtask-1       ← 子任务 worktree（fork 自 goal 分支）
      ├── fix/subtask-2        ← 子任务 worktree
      └── feat/subtask-3       ← 子任务 worktree
```

- 子任务分支从 `goal/<name>` 分支 fork 出去，完成后 merge 回 `goal/<name>`
- `goal/<name>` 分支不直接进 main，由用户审核后手动 merge
- 这保证了 main 的纯洁性

### 2. Orchestrator 在 Bot 中的定位

```
TelegramBot
├── StateManager          ← 已有：Topic/Session 管理
├── ClaudeClient          ← 已有：Claude 进程管理
├── MessageQueue          ← 已有：Telegram 消息
├── ApiServer             ← 已有：HTTP API
└── GoalOrchestrator      ← 新增：Goal 自动调度
    ├── 读取 Notion Goal 子任务
    ├── 派发子任务到 worktree
    ├── 监控子任务完成
    ├── 自动 merge 到 goal 分支
    └── 通过 Telegram 通知用户
```

GoalOrchestrator 是 Bot 内部模块，直接使用现有的 `ClaudeClient`、`StateManager`、`MessageQueue` 等服务。不需要通过 HTTP API 中转。

### 3. 状态持久化（解决 context 爆炸）

本地状态文件 `data/goals/<goal-id>.json`：

```typescript
interface GoalDriveState {
  goalId: string;              // Notion page ID
  goalName: string;
  goalBranch: string;          // "goal/<name>"
  goalTopicId: number;         // 调度员 topic（用于通知用户）
  baseCwd: string;             // 主仓库路径
  status: 'running' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;

  tasks: GoalTask[];
}

interface GoalTask {
  id: string;                  // 本地唯一 ID（t1, t2, ...）
  description: string;         // 子任务描述（来自 Notion）
  type: '代码' | '手动' | '调研';
  depends: string[];           // 依赖的 task ID（如 ["t1", "t2"]）
  phase?: number;              // 可选：分批编号

  // 执行状态
  status: 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
  branchName?: string;         // 分配的分支名
  topicId?: number;            // 对应的 Telegram Topic ID
  dispatchedAt?: number;
  completedAt?: number;
  error?: string;              // 失败原因
  merged?: boolean;            // 是否已 merge 到 goal 分支
}
```

### 4. 触发方式

采用用户确认的 **完全自动** 模式：

- 在 Goal skill 的**继续模式**中，展示摘要后，如果有可执行的子任务，直接提示：
  ```
  🎯 <Goal Name>
  📊 进度: 2/6
  🔜 可并行执行: 3 个子任务

  🚀 自动推进中...
  ```
- Orchestrator 自动开始派发，不需要额外命令
- 用户也可以随时通过 Telegram 消息干预（暂停、跳过、调整优先级）

**同时新增 API 端点**，让 skill 和其他模块可以触发/查询 orchestration：

```
POST /api/goals/:goalId/drive    ← 启动 drive
GET  /api/goals/:goalId/status   ← 查看 drive 状态
POST /api/goals/:goalId/pause    ← 暂停
POST /api/goals/:goalId/resume   ← 恢复
```

### 5. 依赖关系处理

支持两种依赖标注方式（在 Notion Goal 子任务中）：

**方式 A：显式依赖**
```markdown
- [ ] `[代码]` t1: 创建数据模型
- [ ] `[代码]` t2: 实现 API 端点 — depends: t1
- [ ] `[代码]` t3: 编写前端页面 — depends: t1
- [ ] `[代码]` t4: 集成测试 — depends: t2, t3
```

**方式 B：Phase 分批**
```markdown
## Phase 1
- [ ] `[代码]` 创建数据模型
- [ ] `[代码]` 配置数据库

## Phase 2
- [ ] `[代码]` 实现 API 端点
- [ ] `[代码]` 编写前端页面

## Phase 3
- [ ] `[代码]` 集成测试
```

**调度规则：**
- 只派发所有依赖都已 `completed` 的任务
- Phase N+1 的任务在 Phase N 全部完成后才派发
- `[手动]` 类型的任务不自动执行，标记为 `blocked` 并通知用户
- `[调研]` 类型正常派发（Claude 可以做调研）

### 6. 子任务完成检测与自动 Merge

**利用现有的事件机制**，不需要轮询 Notion：

1. Orchestrator 通过现有的 `handleBackgroundChat()` 派发子任务
2. 在 `onProgress` 回调中监控 `result` event
3. 收到 `result` 后：
   - 检查子任务的 worktree 是否有未提交的更改（`git status`）
   - 如果有，自动 commit
   - 执行 `git merge <subtask-branch>` 到 `goal/<name>` 分支
   - 如果 merge 冲突 → 标记为 `failed`，通知用户
   - 如果 merge 成功 → 清理 worktree 和分支，删除 topic
   - 更新本地状态文件
   - 更新 Notion Goal 页面进度
   - 检查是否有新的可派发任务 → 继续派发

**自动 merge 流程（在 goal 分支的 worktree 中操作）：**

```
goal/<name> worktree:
  git merge feat/subtask-1 --no-edit
  → 成功 → cleanup subtask-1 worktree + branch + topic
  → 冲突 → git merge --abort → notify user
```

### 7. 通知策略

所有通知发送到 **Goal 对应的 Telegram Topic**（调度员 topic）：

| 事件 | 通知内容 | 优先级 |
|------|---------|--------|
| 子任务派发 | `🚀 派发: <task> → <branch>` | normal |
| 子任务完成 | `✅ 完成: <task> (Xs, NK tokens)` | normal |
| 自动 merge 成功 | `🔀 已合并: <branch> → goal/<name>` | normal |
| merge 冲突 | `⚠️ 合并冲突: <branch>，需要手动处理` | **high** |
| 子任务失败 | `❌ 失败: <task> — <error>` | **high** |
| 需要用户输入 | `🤔 <task> 需要你的决策: <question>` | **high** |
| Phase 完成 | `📊 Phase N 完成，开始 Phase N+1` | normal |
| Goal 全部完成 | `🎉 Goal 全部子任务完成！请审核 goal/<name> 分支` | **high** |
| 手动任务提醒 | `👋 手动任务: <task>，完成后回复"done"` | **high** |

### 8. 并发控制

- **最大并行子任务数**：可配置，默认 3（避免过多 Claude 进程抢资源）
- **每个子任务一个独立 Topic**：复用现有的 fork 机制
- **子任务之间的代码冲突**：
  - 由于都是从 `goal/<name>` 分支 fork 出来的，初始代码一致
  - 合并时如果冲突，先到先得（先完成的先 merge），后面的任务在最新的 goal 分支基础上 rebase 或通知用户

---

## 实现计划

### Phase 1: 基础架构

**1.1 新增类型定义** (`telegram/types/index.ts`)
- 添加 `GoalDriveState`、`GoalTask` 等接口
- 添加 orchestrator 相关配置项

**1.2 新增 GoalOrchestrator 模块** (`telegram/orchestrator/`)
- `index.ts` — GoalOrchestrator 主类
  - `startDrive(goalId, goalTopicId)` — 启动 Goal 调度
  - `pauseDrive(goalId)` / `resumeDrive(goalId)` — 暂停/恢复
  - `onTaskCompleted(goalId, taskId)` — 子任务完成回调
  - `onTaskFailed(goalId, taskId, error)` — 子任务失败回调
  - `getStatus(goalId)` — 获取调度状态
- `goal-state.ts` — 状态文件读写
  - `loadState(goalId)` / `saveState(state)` — 持久化
  - `parseNotionGoal(page)` — 从 Notion 页面解析子任务和依赖
- `task-scheduler.ts` — 调度决策逻辑
  - `getDispatchableTasks(state)` — 返回所有依赖满足的 pending 任务
  - `getNextBatch(state, maxConcurrent)` — 返回下一批要派发的任务
- `goal-branch.ts` — Goal 分支的 git 操作
  - `createGoalBranch(cwd, goalName)` — 创建 `goal/<name>` 分支
  - `mergeSubtaskBranch(goalCwd, subtaskBranch)` — 合并子任务分支
  - `cleanupSubtask(cwd, worktreePath, branchName)` — 清理子任务 worktree

**1.3 扩展 git-utils.ts**
- 新增 `mergeBranch(cwd, branchName)` — merge 操作
- 新增 `getCurrentBranch(cwd)` — 获取当前分支
- 新增 `hasUncommittedChanges(cwd)` — 检查未提交更改
- 新增 `autoCommit(cwd, message)` — 自动 commit

### Phase 2: 集成到 Bot

**2.1 集成到 TelegramBot 主类** (`telegram/bot/telegram.ts`)
- 在 constructor 中初始化 GoalOrchestrator
- 在 launch() 中恢复进行中的 Goal drive（从 `data/goals/` 加载状态）
- 在 stop() 中保存 orchestrator 状态

**2.2 新增 API 端点** (`telegram/api/routes/goals.ts`)
- `POST /api/goals/:goalId/drive` — 启动 drive
- `GET /api/goals/:goalId/status` — 查看状态
- `POST /api/goals/:goalId/pause` — 暂停
- `POST /api/goals/:goalId/resume` — 恢复

**2.3 更新 API Server** (`telegram/api/server.ts`)
- 注册新的 goal 路由
- 将 GoalOrchestrator 注入到 ApiDeps

### Phase 3: Skill 联动

**3.1 更新 Goal Skill** (`skills/goal/SKILL.md`)
- 继续模式中检测是否有可执行子任务
- 如果有，自动调用 `POST /api/goals/:goalId/drive` 启动调度
- 展示实时状态

**3.2 更新 Notion Goal 页面结构**
- 子任务支持 `depends: tN` 语法
- 子任务支持 Phase 分组
- 新增 `Drive Status` 字段（可选）

### Phase 4: 健壮性

**4.1 Bot 重启恢复**
- 启动时扫描 `data/goals/` 目录，恢复所有 `running` 状态的 drive
- 检查已派发任务的进程是否仍存活（复用 executor 的 reconnect 机制）
- 失败的自动重新派发

**4.2 错误处理**
- merge 冲突：暂停该分支，通知用户，不影响其他子任务
- Claude 进程崩溃：标记任务 failed，可选自动重试（最多 1 次）
- Notion API 不可用：降级为纯本地模式，事后同步

**4.3 用户干预接口**
- 在 Goal Topic 中回复消息可以：
  - "pause" / "暂停" → 暂停调度
  - "resume" / "继续" → 恢复调度
  - "skip t3" → 跳过子任务 t3
  - "done t5" → 标记手动任务 t5 完成
  - "retry t2" → 重试失败的子任务 t2
  - "status" → 查看当前状态

---

## 文件变更清单

```
新增文件:
  telegram/orchestrator/index.ts          ← GoalOrchestrator 主类
  telegram/orchestrator/goal-state.ts     ← 状态持久化 + Notion 解析
  telegram/orchestrator/task-scheduler.ts ← 调度算法
  telegram/orchestrator/goal-branch.ts    ← Goal 分支 git 操作
  telegram/api/routes/goals.ts            ← Goal API 端点

修改文件:
  telegram/types/index.ts                 ← 新增 orchestrator 类型
  telegram/utils/git-utils.ts             ← 新增 merge/commit 相关函数
  telegram/bot/telegram.ts                ← 初始化和生命周期集成
  telegram/api/server.ts                  ← 注册新路由
  telegram/api/types.ts                   ← ApiDeps 扩展
  skills/goal/SKILL.md                    ← 继续模式增加自动推进
```

---

## 关键问题与权衡

### Q1: Orchestrator 如何读取 Notion？

**方案**: Orchestrator 不直接调 Notion MCP。而是：
1. **Goal Skill 调用时**，由 Claude 实例读取 Notion 并生成结构化数据
2. **通过 API 传递**给 Orchestrator（`POST /api/goals/:goalId/drive` body 中携带解析后的子任务列表）
3. Orchestrator 保存到本地状态文件，后续不再依赖 Notion

**好处**：Orchestrator 不需要 Notion 凭据，逻辑更简单。Notion 更新由完成回调中的 Claude 实例代劳。

### Q2: 子任务 fork 的 parent topic 是什么？

**方案**: 创建一个专门的 **Goal Topic**（`🎯 goal/<name>`），作为：
- 子任务的 parent topic（fork 来源）
- 调度通知的目标
- 用户干预的交互通道

这个 Goal Topic 的 cwd 指向 `goal/<name>` 分支的 worktree。

### Q3: 后续子任务需要在 merge 后的最新代码上工作

**方案**: Phase N+1 的任务在 Phase N 全部 merge 到 goal 分支后，从最新的 goal 分支 fork。这样保证后续任务能看到前面任务的成果。

### Q4: 并发 merge 冲突

如果 t1 和 t2 同时完成，t1 先 merge 成功，t2 merge 时可能冲突。

**方案**: merge 操作串行化（使用 lockKey），冲突时通知用户，提供选项：
1. 用户手动解决冲突
2. 在新 goal 分支基础上重新执行 t2
