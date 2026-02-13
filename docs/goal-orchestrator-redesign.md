# Goal Orchestrator 自适应调度改进

> 讨论日期: 2026-02-13
> 状态: 设计讨论中

## 背景

当前 Goal 调度引擎的任务计划是**静态的**：启动前拆好所有子任务，执行过程中计划不可变。实际使用中暴露两个问题：

1. **子任务粒度难以把握** — 过细导致效率低下（频繁切换上下文、过多分支合并），过粗导致子任务执行困难
2. **缺少执行时反馈** — 开发过程中发现的问题（需求变化、技术障碍、任务冗余）无法反馈给调度器

### 当前架构的局限

```
拆分任务（一次性） → 分发 → 执行 → 完成/失败（二元信号） → 分发下一批
```

- 任务一旦分发，与调度器之间**没有反馈通道**
- 调度器只知道 completed/failed，不知道"为什么"
- 调研型任务的产出无法自动影响后续计划
- 无法在执行中合并、拆分、重排任务

---

## 已确认：自动解决合并冲突已实现

Commit `5d7b16a`（已在 main），实现在 `orchestrator/conflict-resolver.ts`：
- 子任务分支合并产生冲突时，自动调用 Claude 解决
- 限制工具集：Read/Write/Edit/Bash/Glob/Grep
- 成功则自动 commit，失败则标记 `blocked` 等待人工介入

---

## 改进方向：自适应调度

核心思路：**让计划成为活的，可以在执行过程中演化。**

### 机制 A：任务主动反馈（Task → Orchestrator）

子任务在执行过程中，可以主动通知调度器调整计划。

**触发场景：**
- 任务发现比预期复杂，建议拆分
- 任务发现某个后续任务不需要做了
- 任务需要先调研某个技术方案
- 任务发现和另一个任务高度重叠，建议合并

**反馈类型（初步）：**

| 类型 | 含义 | 调度器响应 |
|------|------|-----------|
| `replan` | 需要根据本任务产出重新规划剩余任务 | 暂停分发，AI 重新审视计划 |
| `add_task` | 需要增加新子任务 | 插入新任务到任务图 |
| `remove_task` | 某个任务已不需要 | 标记为 skipped |
| `split_self` | 当前任务太大，建议拆分 | 将当前任务拆为多个 |
| `merge_tasks` | 某几个任务应该合并 | 合并任务描述和依赖 |
| `block_on` | 需要等待某个未计划的调研/决策 | 创建调研任务并设为依赖 |

### 机制 B：调度器主动审查（Orchestrator checkpoint）

每个任务完成后，调度器不再机械分发下一批，而是先做一次**计划审查**。

**审查时机：**
- 每个任务完成后（轻量审查）
- 每个 phase 完成后（深度审查）
- 调研型任务完成后（必须审查）

**审查内容：**
- 已完成任务的产出是否改变了对剩余任务的理解
- 剩余任务的粒度是否合理
- 是否有任务可以跳过或合并
- 依赖关系是否需要调整

### 调研型任务反哺计划

这是一个特别重要的场景：

> 功能可能比较小众，AI 并不了解，需要先调研市面常见方案再制定执行计划。
> 调研之前 AI 生成的子任务很可能只是拍脑袋的决策，真正的任务划分需要等待调研完成。
> 这个过程不一定出现在任务最开始，还可能在任务执行中发现。

**当前 `type: '调研'` 的问题：** 只是一个标签，调研结果不会回流到计划中。

**改进思路：**

1. 调研任务完成时，要求其产出一份结构化的调研结论（而不仅仅是"完成了"）
2. 调度器读取调研结论，结合原始 Goal 描述和剩余任务，重新生成计划
3. 支持"占位符任务"— 在调研完成前，后续任务标记为 `blocked_by_research`，不提前细化

**示例流程：**

```
Goal: 实现全文搜索功能

Phase 1（初始计划，粗粒度）:
  t1: [调研] 调研全文搜索方案（Elasticsearch / Meilisearch / SQLite FTS5）
  t2: [占位] 实现搜索功能（等 t1 完成后细化）
  t3: [占位] 集成到前端（等 t2 完成后细化）

t1 完成，产出调研结论: "推荐 Meilisearch，因为..."

→ 调度器 replan:

Phase 2（细化后）:
  t2a: 安装配置 Meilisearch Docker 容器
  t2b: 实现数据索引同步 Service
  t2c: 实现搜索 API 端点
  t3a: 前端搜索组件
  t3b: 搜索结果高亮显示
```

---

## 已确定的设计决策

### 决策 1：反馈通道 — 文件信号 + 进程结束

**方案：** 子任务写 `.goal-feedback.json` 到 worktree 后自行结束进程。

**原因：** 任务说"做不下去了"之后本就应该停下来，不存在"通知调度器后继续干活"的场景。进程结束是天然的阻塞信号。

**实现：**
- task prompt 里约定：遇到阻塞时写 `.goal-feedback.json` 后结束
- `onTaskCompleted` 回调中增加判断：

```
进程结束 → 检查 .goal-feedback.json 是否存在
  → 存在：标记 blocked_feedback，读取反馈，触发审查/replan
  → 不存在：正常 completed，走原有流程（可选：轻量审查）
```

**排除的方案：** 子任务调 Bot API（B 方案）。原因：
- prompt 膨胀（要注入 API 地址、goalId、taskId）
- 通知后任务还活着但无事可做（浪费算力）
- 调度器 replan 的同时任务还在跑（竞态风险）

### 决策 2：任务状态扩展

```
pending → dispatched → running
                         ├→ completed           （正常完成，可附带 feedback 文件）
                         ├→ failed              （异常失败）
                         ├→ blocked_feedback    （主动阻塞，需要调度器介入）
                         │    → replan 后可能：
                         │      - 变为 skipped（不需要了）
                         │      - 拆分为新任务
                         │      - 以新描述重新 dispatch
                         └→ paused              （被冻结，等待用户决策）
                              ├→ resume → running（继续执行）
                              └→ cancelled       （用户确认取消）
```

**paused 的定位：** 安全阀。当系统不确定该怎么处理时（replan 想取消正在跑的任务、用户触发回滚），先 pause 冻结现场，防止损失扩大，再交给用户决策。stop 是不可逆的，必须由用户主动触发。

### `.goal-feedback.json` 格式

```json
{
  "type": "replan | add_task | remove_task | split_self | merge_tasks | block_on",
  "reason": "为什么需要调整",
  "details": {
    // type=replan: 调研结论或发现的问题
    "findings": "调研发现 Meilisearch 最适合，因为...",
    // type=add_task: 建议增加的任务
    "task": { "description": "...", "depends": ["t1"] },
    // type=split_self: 建议拆分方式
    "subtasks": ["子任务1描述", "子任务2描述"],
    // type=remove_task: 建议移除的任务 ID
    "taskIds": ["t3"],
    // type=block_on: 需要什么前置调研/决策
    "research": "需要先确认 X 技术方案"
  }
}
```

### 决策 3：分级自治 + 快照保底

**核心原则：** 快照解决"事后能不能恢复"，但大的 replan 即使能恢复，错误执行本身的 token/时间成本已经发生。因此不能用快照替代人工判断，需要分级。

#### 分级策略

| 影响级别 | 变更类型 | 处理方式 |
|---------|---------|---------|
| **低** | skip 单个任务、微调任务描述 | AI 自治，执行后通知 |
| **低** | add 一个小任务（不影响依赖链） | AI 自治，执行后通知 |
| **中** | split 一个任务为 2-3 个子任务 | AI 自治，执行后通知 |
| **高** | replan 重构多个任务 | **暂停，等用户确认** |
| **高** | 改变任务依赖关系 / 新增 phase | **暂停，等用户确认** |
| **高** | 调研结论导致方向性变更 | **暂停，等用户确认** |

**判断标准（供 AI 参考）：**
- 影响 ≤ 1 个未开始的任务 → 低
- 影响 2-3 个未开始的任务且不改变整体方向 → 中
- 影响 ≥ 3 个任务、改变依赖结构、或涉及方向性决策 → 高

#### 快照机制

每次计划变更前保存快照，无论是否需要人工确认。

**快照内容：**

```sql
CREATE TABLE goal_checkpoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     TEXT NOT NULL REFERENCES goals(id),
  trigger     TEXT NOT NULL,       -- 'replan' | 'merge' | 'split' | 'feedback'
  trigger_task_id TEXT,            -- 触发变更的任务 ID
  reason      TEXT,                -- 变更原因
  tasks_snapshot TEXT NOT NULL,    -- JSON: 变更前的完整任务列表
  git_ref     TEXT,                -- goal 分支的 commit hash
  change_summary TEXT,             -- 人类可读的变更摘要
  created_at  INTEGER NOT NULL
);
```

**快照时机：**
- replan 之前（最重要）
- merge 完成后
- 任务拆分/合并时

#### 用户交互流程

**低/中影响（自动执行）：**
```
子任务反馈 → 保存快照 → AI 自动调整计划 → goal thread 发通知：
  "已自动调整: skip t3（原因: 与 t2 功能重叠）
   [回滚到上一版本]"
```

**高影响（等待确认）：**
```
子任务反馈 → 保存快照 → AI 生成新计划 → goal thread 发审批请求：
  "调研结论：推荐 Meilisearch（详见 t1 产出）

   计划变更：
   - 删除: t2（占位：实现搜索功能）
   - 新增: t2a 安装配置 Meilisearch
   - 新增: t2b 实现数据索引同步
   - 新增: t2c 实现搜索 API
   - 修改: t3 → 拆分为 t3a + t3b

   [批准]  [修改后批准]  [回滚]"
```

**回滚操作：**
```
用户点击 [回滚] 或 /goal rollback
  → 恢复任务计划到快照版本
  → git reset --hard <saved_hash>
  → 清理错误 dispatch 的子任务分支/channel
```

### 决策 4：占位符任务 — `type: '占位'`

在现有 `'代码' | '手动' | '调研'` 基础上新增 `'占位'` 类型。

**行为规则：**
- 调度器不分发占位任务
- 当待分发队列中出现占位任务时，强制触发 replan
- replan 将占位任务替换为具体任务后，调度器正常分发

**时序保证：**
```
调研任务完成 → merge → 调度器准备分发下一批
  → 发现队列中有 type='占位' → 强制 replan
  → replan 替换占位符为具体任务 → 分发具体任务
```

不需要新 status，只需要 `GoalTask.type` 枚举多一个值。

### 决策 5：审查触发条件 — 按需触发，非每次

第一版不做每个任务完成后的通用审查，只在以下条件触发：

| 触发条件 | 审查类型 | 是否必须 |
|---------|---------|---------|
| 任务携带 `.goal-feedback.json` | 按 feedback type 处理 | 必须 |
| 调研任务完成 | 深度审查 + replan | 必须 |
| 待分发队列包含占位任务 | replan 替换占位符 | 必须 |
| phase 完成 | 轻量检查下一 phase 是否合理 | 可选 |
| 普通代码任务完成 | 不审查，走原有流程 | — |

**原因：** 每个任务都审查会引入不必要的延迟和 token 成本。等实际使用中发现确实需要更频繁的审查再迭代。

### 决策 6：replan prompt 设计 — 输出变更指令而非全新计划

**输入上下文：**

```
1. 原始 Goal 描述
2. 当前任务全景（已完成 / 进行中 / 待分发 / 占位）
3. 触发 replan 的原因（feedback 内容 / 调研结论）
4. 已完成任务的产出摘要（git diff stat 或 feedback.findings）
5. 约束：已完成的任务不可修改，只能调整 pending / 占位任务
```

**输出格式 — 结构化变更指令：**

```json
{
  "changes": [
    { "action": "remove", "taskId": "t2" },
    { "action": "add", "task": { "id": "t2a", "description": "...", "depends": ["t1"], "phase": 2 } },
    { "action": "add", "task": { "id": "t2b", "description": "...", "depends": ["t2a"], "phase": 2 } },
    { "action": "modify", "taskId": "t3", "description": "更新后的描述..." }
  ],
  "reasoning": "根据调研结论，选择 Meilisearch 方案，将原占位任务拆分为...",
  "impact_level": "low | medium | high"
}
```

**为什么输出变更指令而非全新计划：**
- 方便生成人类可读的 diff（审批界面直接展示增删改）
- 减少 AI 犯错面（只修改需要改的部分，不会意外丢掉已有任务）
- `impact_level` 由 AI 自评，调度器据此决定自动执行还是等用户确认

### 决策 7：快照保留策略

- 每个 goal 保留最近 **10 个快照**
- 快照体积很小（JSON 任务列表 + commit hash）
- Goal 完成后压缩为只保留首末两个快照
- 超过 10 个时自动淘汰最旧的

---

## 设计总结

### 完整流程图

```
Goal 创建 → 拆分子任务（含调研 + 占位任务）
                ↓
         保存快照 #0（初始计划）
                ↓
         调度器分发第一批任务
                ↓
    ┌───────────────────────────┐
    │     子任务执行循环         │
    │                           │
    │  任务完成 ──→ 检查反馈文件  │
    │    │           │          │
    │    │      有反馈文件?       │
    │    │       ↙      ↘       │
    │    │     是        否      │
    │    │     ↓         ↓      │
    │    │  blocked    正常完成   │
    │    │  _feedback    │      │
    │    │     ↓         ↓      │
    │    │   读取反馈   merge     │
    │    │     ↓         ↓      │
    │    │     └──→ 准备分发 ←──┘ │
    │    │           ↓          │
    │    │    需要 replan?       │
    │    │    (反馈/调研/占位)    │
    │    │       ↙      ↘       │
    │    │     是        否      │
    │    │     ↓         ↓      │
    │    │  保存快照   正常分发   │
    │    │     ↓                │
    │    │  AI 生成变更指令      │
    │    │     ↓                │
    │    │  判断 impact_level   │
    │    │     ↓                │
    │    │  low/med → 自动执行   │
    │    │  high → 等用户确认    │
    │    │     ↓                │
    │    │  应用变更 → 分发      │
    │    │     ↓                │
    │    └──→ 继续循环 ←────────┘
    └───────────────────────────┘
                ↓
         所有任务完成
                ↓
         Goal 完成通知
```

### 新增/修改的组件

| 组件 | 类型 | 说明 |
|------|------|------|
| `GoalTask.type: '占位'` | 类型扩展 | 不可分发，触发 replan |
| `GoalTaskStatus: 'blocked_feedback'` | 状态扩展 | 任务主动阻塞，等待 replan |
| `GoalTaskStatus: 'paused'` | 状态扩展 | 任务被冻结，等待用户决策 |
| `GoalTaskStatus: 'cancelled'` | 状态扩展 | 用户确认后取消的任务 |
| `feedback/<taskId>.json` | 文件协议 | 子任务 → 调度器的反馈通道 |
| `goal_checkpoints` 表 | 新表 | 快照存储 |
| `replanTasks()` | 新方法 | 调用 AI 生成变更指令 |
| `applyChanges()` | 新方法 | 将变更指令应用到任务图 |
| `reviewAndDispatch()` | 改造 | 分发前检查是否需要 replan |
| `pauseTask()` / `resumeTask()` | 新方法 | 任务级暂停/恢复 |
| task prompt 增强 | prompt 改动 | feedback 文件协议 + 调研占位引导 |

### 决策 8：补充设计（回顾后修正）

#### 8a. 调研任务产出统一用 `.goal-feedback.json`

调研任务正常 completed，但同样在完成前写 feedback 文件（`type: "replan"`，`findings` 里放调研结论）。orchestrator 对所有完成的任务统一检测 feedback 文件，不区分"主动阻塞"和"完成后反馈"——同一个检测点，同一个处理流程。

#### 8b. feedback 文件存储规范

- **存储路径：** goal 分支 worktree 下的 `feedback/` 目录
- **文件命名：** `feedback/<taskId>.json`（按任务区分，支持并发多任务同时写入）
- **Git 忽略：** `feedback/` 加入 `.gitignore`，不污染代码库
- orchestrator 读取后保留文件（作为审计记录），不删除

#### 8c. 并发任务冲突 — pause 优先

replan 只直接修改 `pending` 状态的任务。对于正在运行的任务：

```
replan 决定取消正在跑的任务
  → 不直接 stop/cancel
  → 先 pause 该任务（冻结现场，防止损失扩大）
  → 标记为 high impact，等待用户确认
  → 用户确认后：stop + 清理，或 resume 继续跑
```

**原因：** stop 是不可逆的（进程终止、上下文丢失），需要用户主动参与决策。pause 是安全阀——不确定时先冻结，不让事情变更复杂。

#### 8d. 回滚时的处理 — 同样 pause 优先

```
用户触发回滚
  → 第一时间 pause 所有基于被回滚计划 dispatch 的任务
  → 评估成本（这些任务跑了多久、产出了多少代码）
  → 展示给用户：
    "以下任务将被清理：
     - t2a (已运行 3 分钟，修改了 2 个文件)
     - t2b (已运行 1 分钟，无产出)
     [确认清理]  [保留已有产出]  [取消回滚]"
  → 用户确认后执行 stop + 清理分支/channel
```

#### 8e. 初始拆分引导

在 goal 创建时的 system prompt 中增加引导规则：

> 对于不确定的技术方案或实现路径，使用"调研 + 占位"模式：
> - 先创建一个 `type: '调研'` 的任务来调研方案
> - 后续依赖的任务使用 `type: '占位'`，不要猜测具体实现
> - 只有明确知道如何实现的部分才拆为 `type: '代码'` 任务

#### 8f. 任务级 pause 能力

当前只有 goal 级别的 pause/resume。需要新增**任务级别**的 pause：

```
GoalTaskStatus 扩展：
  pending → dispatched → running
                           ├→ completed
                           ├→ failed
                           ├→ blocked_feedback
                           └→ paused   ← 新增
                                ├→ resume → running
                                └→ stop（用户确认）→ cancelled ← 新增
```

**实现方式：** 向 Claude Code CLI 子进程发送暂停信号（SIGTSTP），或通过 executor 的 interrupt 机制实现。恢复时发送 SIGCONT 或重新 attach。

### 数据库变更

```sql
-- Migration 002: Goal 自适应调度

-- 1. goal_tasks.type 扩展（允许 '占位'）
-- SQLite 无 ENUM，type 已是 TEXT，无需 DDL 变更，代码层面扩展即可

-- 2. goal_tasks.status 扩展（允许 'blocked_feedback'）
-- 同上，代码层面扩展

-- 3. 新增快照表
CREATE TABLE goal_checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id         TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  trigger         TEXT NOT NULL,
  trigger_task_id TEXT,
  reason          TEXT,
  tasks_snapshot  TEXT NOT NULL,
  git_ref         TEXT,
  change_summary  TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_goal_checkpoints_goal
  ON goal_checkpoints(goal_id, created_at);
```
