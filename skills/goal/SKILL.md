---
name: goal
description: >
  管理开发目标。无参数列出活跃 Goals；`drive all` 批量启动所有 Planned Goals 的自动推进；
  有参数时搜索匹配的 Goal 进入继续模式，没找到则进入创建模式。支持子任务拆解、计划确认、进度跟踪、方向变更。
version: 4.0.0
---

# Goal - 开发目标管理

管理大型开发目标，支持子任务拆解、进度跟踪和方向变更。

**数据存储**: SQLite（通过 MCP 工具访问）

## 状态流

```
Pending → Collecting → Planned → Processing → Completed → Merged
                                      ↓
                                  Blocking（需用户参与）
```

| 状态 | 含义 |
|------|------|
| Pending | 刚创建/从 Idea 提升，等待启动讨论 |
| Collecting | 与用户对话收集信息阶段 |
| Planned | 计划已确认，等待启动 drive |
| Processing | Drive 运行中，任务自动执行 |
| Blocking | 被阻塞，需要用户参与 |
| Completed | 所有任务完成 |
| Merged | 已合并到 main，最终归档状态 |

## 模式判断

根据 `{{SKILL_ARGS}}` 决定模式：

- **为空** → 列表模式
- **`drive all`** → 批量推进模式
- **不为空（其他）** → 搜索 → 找到则继续模式，没找到则创建模式

---

## 列表模式（无参数）

```
bot_list_goals(status="Collecting")
bot_list_goals(status="Planned")
bot_list_goals(status="Processing")
bot_list_goals(status="Blocking")
bot_list_ideas(status="Idea")
```

展示格式：

```
当前目标

Collecting
  g1. <Goal Name> — 收集信息中

Planned
  g2. <Goal Name> — 计划已确认，待启动

Processing
  g3. <Goal Name> — 进度: <Progress> | 下一步: <Next>

Blocking
  g4. <Goal Name> — 卡在: <BlockedBy>

Idea (最近 5 个)
  1. <Idea Name>
```

---

## 批量推进模式（drive all）

1. **查询所有 Planned Goals**

   ```
   bot_list_goals(status="Planned")
   ```

2. **逐个处理每个 Planned Goal**

   a. 获取详情（含子任务）：`bot_get_goal(goal_id="<id>")`

   b. 检查是否有未完成的 `[代码]` 或 `[调研]` 子任务（status=pending）

   c. 如果有 → 更新状态为 Processing，然后调用 Drive API 启动：
      ```bash
      curl -s -X POST -H 'Content-Type: application/json' \
        -d '{"goalName":"<Name>","goalThreadId":"{{THREAD_ID}}","baseCwd":"<cwd>","tasks":[子任务数组],"maxConcurrent":3}' \
        "http://127.0.0.1:3456/api/goals/<goal-id>/drive"
      ```
      ```
      bot_update_goal(goal_id="<id>", status="Processing")
      ```

   d. 如果没有可自动执行的子任务 → 跳过

3. **汇总输出**

处理完成后不进入交互模式。

---

## 搜索匹配

```
bot_list_goals(q="<用户输入的关键词>")
```

找到 → 继续模式；没找到 → 创建模式；多个匹配 → 列出让用户选择。

---

## 创建模式

### 1. 创建 Goal（Collecting 状态）

先创建 Goal 以记录上下文：

```
bot_create_goal(
  name="<Goal 标题（简短，10 字以内）>",
  project="<项目名>",
  status="Collecting",
  type="<探索型|交付型>",
  completion="<完成标准（一句话）>"
)
```

### 2. 与用户讨论

和用户一起明确以下信息（通过对话）：

- **类型**：探索型（不确定最终形态）还是 交付型（明确的交付物）
- **完成标准**：怎样算"做完了"
- **子任务拆解**：按**功能点**拆分，不按技术层拆分
  - 一个功能点 = 一个子任务，即使涉及前端+后端+API 也归同一个任务
  - 只有真正独立的功能（无代码耦合、可独立交付）才拆成不同子任务
  - 每个子任务标注类型和复杂度：`[代码, simple]` / `[代码, complex]` / `[手动]` / `[调研]`
  - 代码任务复杂度判断：simple = 逻辑直观、有模式可参考；complex = 需要架构设计或跨模块协调。默认 simple
  - 代码类子任务注明技术选择
  - 标注依赖关系：`— depends: t1, t2`
  - 可选使用 Phase 分组
- **关键决策**：记录讨论中做出的重要决策

### 3. 写入 body

创建成功后获取返回的 id，然后更新 body：

```
bot_update_goal(
  goal_id="<id>",
  progress="0/N 子任务完成",
  next="<第一个待执行的子任务>",
  body="<页面 body Markdown>"
)
```

**页面 body 结构：**

```markdown
## 目标与完成标准
<完成标准的详细描述>

## 当前状态
**进度**: 0/N 子任务完成
**下一步**: <第一个子任务>
**卡点**: 无

## 子任务

> 子任务 ID 使用 t1, t2 格式。Drive 时系统会自动加上 goal seq 前缀（如 g2t1），
> 用于分支名、Channel 名等，无需手动处理。

- [ ] `[代码, simple]` t1: 功能点描述 — 技术备注
- [ ] `[代码, complex]` t2: 功能点描述 — depends: t1
- [ ] `[调研]` t3: 调研主题描述 — depends: t1
- [ ] `[代码, simple]` t4: 功能点描述 — depends: t2, t3

## 决策记录
- **<决策主题>**（<日期>）: <决策内容和原因>

## 已完成子任务存档
暂无

## 待确认
暂无
```

### 4. 计划确认

展示计划摘要给用户确认：

```
**计划确认**

目标: <Goal Name>
类型: <类型>
完成标准: <完成标准>

子任务:
1. `[代码, simple]` t1: xxx
2. `[代码, complex]` t2: xxx — depends: t1
3. ...

请审核以上计划。你可以：
- 提出修改（调整顺序、增删任务、改变依赖等）
- 确认无误后回复"开始"启动执行
```

**讨论循环：**
- 用户提出修改 → 更新 body（`bot_update_goal`）→ 重新展示计划摘要
- 用户确认（"开始" / "start" / "没问题" / "ok" / "lgtm" 等）→ 进入步骤 5

### 5. 启动 Drive

用户确认后：

1. 更新状态为 Planned：
   ```
   bot_update_goal(goal_id="<id>", status="Planned")
   ```

2. 调用 Drive API：
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"goalName":"<Name>","goalThreadId":"{{THREAD_ID}}","baseCwd":"<cwd>","tasks":[子任务数组],"maxConcurrent":3}' \
     "http://127.0.0.1:3456/api/goals/<goal-id>/drive"
   ```

3. 更新状态为 Processing：
   ```
   bot_update_goal(goal_id="<id>", status="Processing")
   ```

4. 输出启动确认

---

## 继续模式

### 1. 读取并展示摘要

```
bot_get_goal(goal_id="<id>")
```

展示摘要：状态、进度、下一步、卡点、待确认事项。

### 2. 按状态路由

**状态 = Collecting：** 继续和用户讨论，完成信息收集后走创建模式的步骤 3-5。

**状态 = Planned（从未 drive 过，drive_status 为空）：**
展示计划摘要，询问用户是否确认启动。确认后走创建模式的步骤 5。

**状态 = Planned / Processing / Blocking（已有 drive_status）：**
如果有未完成的 `[代码]` 或 `[调研]` 子任务，自动启动 Goal Drive：

1. 使用 API 返回的 tasks 数据，如果 tasks 为空但 body 中有子任务，则解析 body
2. 调用 Drive API：
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"goalName":"<Name>","goalThreadId":"{{THREAD_ID}}","baseCwd":"<cwd>","tasks":[子任务数组],"maxConcurrent":3}' \
     "http://127.0.0.1:3456/api/goals/<goal-id>/drive"
   ```
3. 输出启动确认

**状态 = Completed：** 展示完成摘要，提示用户可以 merge。

**状态 = Merged：** 展示归档摘要。

### 3. 根据用户指令更新

等待用户指令，支持：

**完成子任务：**
```
bot_update_goal(goal_id="<id>", body="<更新后 Markdown>", progress="<新进度>", next="<下一步>")
```

**添加子任务：** 在 body 的"子任务"区域追加，然后更新

**记录决策：** 在 body 的"决策记录"中追加（带日期），然后更新

**方向变更：** 审查子任务 → 废弃的移到存档（标注原因）→ 记录决策 → 更新

**标记完成/阻塞/合并：**
```
bot_update_goal(goal_id="<id>", status="Completed|Blocking|Merged")
```

---

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

---

**现在请立即执行。用户输入：{{SKILL_ARGS}}**
