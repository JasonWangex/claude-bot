---
name: goal
description: >
  管理开发目标。无参数列出 Active/Paused Goals；`drive all` 批量启动所有 Active Goals 的自动推进；
  有参数时搜索匹配的 Goal 进入继续模式，没找到则进入创建模式。支持子任务拆解、进度跟踪、方向变更。
version: 3.0.0
---

# Goal - 开发目标管理

管理大型开发目标，支持子任务拆解、进度跟踪和方向变更。

**数据存储**: SQLite（通过 MCP 工具访问）

## 模式判断

根据 `{{SKILL_ARGS}}` 决定模式：

- **为空** → 列表模式
- **`drive all`** → 批量推进模式
- **不为空（其他）** → 搜索 → 找到则继续模式，没找到则创建模式

---

## 列表模式（无参数）

```
bot_list_goals(status="Active")
bot_list_goals(status="Paused")
bot_list_ideas(status="Idea")
```

展示格式：

```
当前目标

Active
  1. <Goal Name> — 进度: <Progress> | 下一步: <Next>

Paused
  1. <Goal Name> — 卡在: <BlockedBy>

Idea (最近 5 个)
  1. <Idea Name>
```

---

## 批量推进模式（drive all）

1. **查询所有 Active Goals**

   ```
   bot_list_goals(status="Active")
   ```

2. **逐个处理每个 Active Goal**

   a. 获取详情（含子任务）：`bot_get_goal(goal_id="<id>")`

   b. 检查是否有未完成的 `[代码]` 或 `[调研]` 子任务（status=pending）

   c. 如果有 → 调用 Drive API 启动：
      ```bash
      curl -s -X POST -H 'Content-Type: application/json' \
        -d '{"goalName":"<Name>","goalThreadId":"{{THREAD_ID}}","baseCwd":"<cwd>","tasks":[子任务数组],"maxConcurrent":3}' \
        "http://127.0.0.1:3456/api/goals/<goal-id>/drive"
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

### 1. 与用户讨论

和用户一起明确以下信息（通过对话）：

- **类型**：探索型（不确定最终形态）还是 交付型（明确的交付物）
- **完成标准**：怎样算"做完了"
- **子任务拆解**：拆解到"执行时不需要做判断"的粒度
  - 每个子任务标注类型：`[代码]` / `[手动]` / `[调研]`
  - 代码类子任务注明技术选择
  - 标注依赖关系：`— depends: t1, t2`
  - 可选使用 Phase 分组
- **关键决策**：记录讨论中做出的重要决策

### 2. 写入 SQLite

创建 Goal：

```
bot_create_goal(
  name="<Goal 标题（简短，10 字以内）>",
  project="<项目名>",
  status="Active",
  type="<探索型|交付型>",
  completion="<完成标准（一句话）>"
)
```

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
- [ ] `[类型]` t1: 子任务描述 — 技术备注
- [ ] `[类型]` t2: 子任务描述 — depends: t1
- [ ] `[类型]` t3: 子任务描述 — depends: t2, t3

## 决策记录
- **<决策主题>**（<日期>）: <决策内容和原因>

## 已完成子任务存档
暂无

## 待确认
暂无
```

---

## 继续模式

### 1. 读取并展示摘要

```
bot_get_goal(goal_id="<id>")
```

展示摘要：进度、下一步、卡点、待确认事项。

### 1.5. 自动推进检测（Drive）

如果有未完成的 `[代码]` 或 `[调研]` 子任务，自动启动 Goal Drive：

1. 使用 API 返回的 tasks 数据，如果 tasks 为空但 body 中有子任务，则解析 body
2. 调用 Drive API：
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"goalName":"<Name>","goalThreadId":"{{THREAD_ID}}","baseCwd":"<cwd>","tasks":[子任务数组],"maxConcurrent":3}' \
     "http://127.0.0.1:3456/api/goals/<goal-id>/drive"
   ```
3. 输出启动确认

### 2. 根据用户指令更新

等待用户指令，支持：

**完成子任务：**
```
bot_update_goal(goal_id="<id>", body="<更新后 Markdown>", progress="<新进度>", next="<下一步>")
```

**添加子任务：** 在 body 的"子任务"区域追加，然后更新

**记录决策：** 在 body 的"决策记录"中追加（带日期），然后更新

**方向变更：** 审查子任务 → 废弃的移到存档（标注原因）→ 记录决策 → 更新

**标记完成/废弃/暂停：**
```
bot_update_goal(goal_id="<id>", status="Done|Abandoned|Paused")
```

---

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

---

**现在请立即执行。用户输入：{{SKILL_ARGS}}**
