# Brain 必要性调查报告

> 分支：`refactor/review-brain-prompt-role`
> 日期：2026-02-20

---

## 一、背景与问题

当前 bot 在 Goal Drive 执行过程中引入了一个名为 **Brain** 的持久化 Opus session，作为"战略顾问"参与任务调度决策。但实际使用中 Brain 表现并不亮眼，需要评估其必要性。

---

## 二、Brain 的设计与职责

### 2.1 是什么

Brain 是为每个 Goal Drive 创建的专属 Discord **Text Channel**，其中运行一个持久化的 **Opus** Claude session。它不执行代码，只做战略层面的决策输出。

- 数据库字段：`goals.drive_brain_channel_id`
- 模型：`pipelineOpusModel`（Opus）
- 生命周期：随 Goal Drive 启动而创建，Goal 完成时归档

### 2.2 四个 Prompt

| Prompt Key | 触发时机 | 输出事件 |
|-----------|---------|---------|
| `orchestrator.brain_init` | Goal Drive 启动时 | — |
| `orchestrator.brain_post_eval` | 每个代码任务合并后 | `brain.eval` |
| `orchestrator.brain_failure` | 任务执行失败时 | `brain.failure` |
| `orchestrator.brain_replan` | 触发重规划时 | `brain.replan` |

### 2.3 三个决策点

```
onTaskCompleted()
  └─ [代码任务 + 有 brain] → brain_post_eval
      └─ needsReplan=true → triggerReplan()

onTaskFailed()
  └─ [有 brain] → brain_failure
      └─ confidence=high && retry → 自动重试
      └─ 其他 → 生成带推荐的按钮

triggerReplan()
  └─ [有 brain] → brain_replan（优先）
      └─ 失败 → fallback: DeepSeek replan
```

---

## 三、Orchestrator 与 Subtask Claude 的完整交互机制

### 3.1 任务启动流程

```
startDrive()
  → reviewAndDispatch()
    → dispatchNext()
      → dispatchTask()
          1. 创建 subtask worktree 分支
          2. 创建 Discord Text Channel
          3. 创建 Claude session（cwd = subtask worktree）
          4. 异步启动 executeTaskPipeline()
```

`executeTaskPipeline` 是**完全异步**的（`(async () => {...})()`），不阻塞主调度循环，支持多任务并行。

### 3.2 三条 Pipeline 路径

| 任务类型 | Pipeline | 使用模型 |
|---------|---------|---------|
| `调研` | `pipelineResearch` | Opus |
| `代码` + `complex` | `pipelineComplexCode` | Opus plan → Sonnet exec → Opus audit |
| `代码` + `simple` | `pipelineSimpleCode` | Sonnet exec → Opus audit |

### 3.3 简单代码任务详细流程

```
pipelineSimpleCode
  │
  ├─ [execute] Sonnet 执行任务 prompt
  │    ↓ handleBackgroundChat(guildId, channelId, taskPrompt)
  │
  ├─ checkFeedbackFile()  ← 读 feedback.main 事件
  │   ├─ feedback? → onTaskCompleted（含 replan 路由）
  │   └─ 无 → 继续
  │
  ├─ [audit] Opus 审查代码
  │   ├─ pass → onTaskCompleted
  │   └─ fail → auditFixLoop
  │
  └─ auditFixLoop（最多 2 轮）
      ├─ [fix] Sonnet 修复
      ├─ [self-review] Sonnet 自查 → feedback.self_review
      └─ [re-audit] Opus 再次审查
          ├─ pass → onTaskCompleted
          └─ 耗尽 → onTaskFailed
```

### 3.4 通信机制（3 层）

#### 层 1：Discord 消息（主通道）

Orchestrator 通过 `handleBackgroundChat(guildId, channelId, prompt)` 向 subtask 发消息：
- 在目标频道 spawn Claude CLI
- 流式处理 JSON 输出
- 返回 usage stats（token/cost）

**这是唯一的"下行"通道**，Orchestrator → Subtask 只有这一条路。

#### 层 2：SQLite 事件（反馈通道）

Subtask Claude 通过 MCP 工具写入事件，Orchestrator 在各 pipeline 节点同步读取：

```
事件类型：
  feedback.main         ← subtask 主动上报（blocked/clarify/replan）
  feedback.self_review  ← Sonnet 自查结果（allIssuesFixed / remainingIssues）
  feedback.investigate  ← 调查结论（continue/retry/replan/escalate）
  brain.eval            ← Brain post-eval（needsReplan）
  brain.failure         ← Brain 失败分析（recommendation/confidence）
  brain.replan          ← Brain 重规划结果（changes/impactLevel）
```

每条事件 `UNIQUE(task_id, event_type)`，`INSERT OR REPLACE` 保证幂等。

#### 层 3：5 秒事件扫描器（兜底）

轮询 `processed_at IS NULL` 的事件，处理 Subtask session crash 后的遗留事件，触发 `onTaskCompleted`。

### 3.5 控制权划分

| 角色 | 职责 | 不做的事 |
|------|------|---------|
| **Orchestrator** | 决定何时切换阶段、何时判定完成/失败、何时进入下一任务 | 不执行代码 |
| **Subtask Claude** | 实际写代码、commit、写反馈事件 | 不控制自身 pipeline 流向 |
| **Brain** | 战略评估、推荐决策 | 不修改状态、不直接调度 |

### 3.6 各阶段模型分配

| Pipeline 阶段 | 模型 | 控制方 |
|-------------|------|-------|
| plan（complex only） | Opus | Orchestrator |
| execute | Sonnet | Orchestrator |
| audit | Opus | Orchestrator |
| fix | Sonnet | Orchestrator |
| self-review | Sonnet | Orchestrator |
| investigation | Sonnet | Orchestrator（异步） |
| brain eval/failure/replan | Opus（brain channel） | Orchestrator（异步） |

---

## 四、Brain 必要性分析

### 4.1 理论价值

Brain 的设计价值是**跨任务上下文积累**：它持久存在，能看到 t1 做了什么、t2 的 diff、t3 的失败原因，理论上能做出更有全局观的决策。

### 4.2 三个决策点的实际价值评估

#### post-eval（每次任务完成后）

- **触发频率**：每个代码任务合并后都触发
- **判断依据**：Brain 看到 diff stats，判断是否需要 replan
- **问题**：
  - 任务本身已经有 Sonnet + Opus 执行，diff 是预期行为
  - Brain 凭 diff stats 判断 needsReplan 的准确率存疑
  - 误判 `needsReplan=true` 会触发不必要的 replan，代价很高
- **结论**：**价值最低，风险最高**

#### failure analysis（任务失败时）

- **触发频率**：任务失败时触发
- **判断依据**：Brain 分析 error message、pipeline phase、retry 次数
- **问题**：
  - Orchestrator 本来就会显示人工干预按钮
  - `confidence=high && retry` 自动重试可能绕过人工判断
  - Brain 无法真正访问代码，分析能力有限
- **结论**：**有一定价值，但存在自动化风险**

#### replan（触发重规划时）

- **触发频率**：较低（replan 本身是低频事件）
- **判断依据**：Brain 有完整任务历史、已完成任务的 diff stats
- **价值**：这是 Brain 价值最高的场景，持久化上下文确实能提升 replan 质量
- **现状**：DeepSeek fallback 已能处理，但信息量少于 Brain
- **结论**：**有实质价值，但依赖 Brain 先前积累的上下文是否完整**

### 4.3 Brain 当前表现不亮眼的可能原因

1. **post-eval 误触发**：Brain 过于积极地建议 replan，产生不必要的噪音
2. **failure analysis 判断偏差**：Brain 看不到实际代码，分析依赖 error message，准确性有限
3. **通信链路复杂**：Brain 需要写 JSON 文件 → SQLite 事件 → Orchestrator 读取，链路越长越脆
4. **Brain init 上下文不够丰富**：初始化时只有 goal body + task 列表，缺乏代码库背景
5. **积累效果未显现**：如果 Goal 任务数少，Brain 的"跨任务积累"优势不明显

### 4.4 系统中已有的 AI 层次

```
Goal 创建       ← 用户 + AI 协作规划（SKILL.md）
Task 执行       ← Sonnet（execute/fix） + Opus（plan/audit）
冲突解决        ← AI 自动 merge
Feedback 调查   ← Sonnet investigation
重规划          ← DeepSeek（fallback）
Brain           ← Opus（战略层，可选）
```

可以看出，**即使没有 Brain，系统仍有完整的 AI 覆盖**。Brain 是锦上添花，而非不可或缺。

---

## 五、改进建议

### 方案 A：砍掉 post-eval，保留 failure + replan

```
移除：onTaskCompleted 中的 brain_post_eval 调用
保留：onTaskFailed 中的 brain_failure
保留：triggerReplan 中的 brain_replan（优先级最高）
```

**理由**：post-eval 是误触发 replan 的主要来源，去掉后 Brain 仍能在最有价值的两个场景发挥作用。

### 方案 B：完全移除 Brain

```
移除：createBrain()、sendToBrain()、所有 brain_* prompt 调用
影响：
  - onTaskFailed → 直接显示人工按钮（原 fallback 逻辑）
  - triggerReplan → 直接使用 DeepSeek replan
```

**理由**：系统各层 AI 已足够完善，人工干预按钮能处理失败场景，DeepSeek 能处理 replan。Brain 带来的复杂度和 Opus token 消耗未必值得。

### 方案 C：重新定位 Brain 的角色

将 Brain 从"自动决策者"改为"辅助顾问"：
- Brain 只在**人工介入点**提供建议（失败时显示在按钮旁）
- 不再自动触发 replan
- 不再自动重试

---

## 六、结论

| 问题 | 结论 |
|------|------|
| Bot goal 阶段有 AI 参与吗？ | **有，多层**：Sonnet 执行、Opus 审查、DeepSeek replan、AI 冲突解决 |
| Brain 是否必要？ | **不是必要的**，系统无 Brain 也能完整运行 |
| Brain 价值最高的场景？ | **replan**（利用跨任务积累的上下文） |
| Brain 最大的问题？ | **post-eval 的误判**，不必要的 replan 触发 |
| 建议？ | 最少：**移除 post-eval**；最彻底：**完全移除 Brain** |
