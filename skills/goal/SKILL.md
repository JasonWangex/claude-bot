---
name: goal
description: 管理大型开发目标，支持子任务拆解、进度跟踪和 Drive 并行执行。当用户提到目标管理、任务拆解、Goal、Drive、"看看当前目标"、"继续之前的任务"时触发。
---

# Goal - 开发目标管理

在 plan mode 的 research → plan → review 流程之上，增加**持久化**（SQLite）和**并行执行**（Drive API）能力。

状态流: `Pending → Collecting → Planned → Processing → Completed → Merged`，Processing 可进入 `Blocking`。

## 模式分发

根据 `$ARGUMENTS`：

| 输入 | 模式 |
|------|------|
| 空 | 列表：查询各状态 Goals + 最近 5 Ideas，按状态分组展示 |
| `drive all` | 批量推进：查询 Planned + Blocking Goals，逐个 Drive 启动，汇总输出 |
| 其他 | `bot_list_goals(q=输入)` → 匹配 1 个→继续；多个→列出选择；无→创建 |

---

## 创建模式

### 1. 建记录

```
bot_create_goal(name="<10字以内>", project="<项目名>", status="Collecting", type="探索型|交付型", completion="<完成标准>")
```

项目名：路径含 `claude-bot` → claude-bot；含 `LearnFlashy` → LearnFlashy；其他 → 目录名。

### 2. 规划（复用 plan mode 流程）

按 plan mode 的自然节奏与用户协作：

**Research** — 理解需求，澄清问题，探索代码库
**Plan** — 按功能点拆子任务（规则见 `references/planning-guide.md`），写入 body（模板见 `references/body-template.md`）
**Review** — 展示计划摘要，进入确认循环：用户修改→更新→重新展示；用户确认（开始/ok/lgtm）→下一步

与标准 plan mode 的区别：计划写入 Goal body（`bot_update_goal`）而非本地 markdown 文件，这样跨会话持久化。

### 3. 启动

`bot_update_goal(status="Planned")` → Drive 启动（见下方）

---

## 继续模式

`bot_get_goal(goal_id)` 获取详情后按状态路由：

| 状态 | 行为 |
|------|------|
| Collecting | 继续 plan mode 规划流程 |
| Planned（tasks 全 pending 或为空） | 展示计划，确认后 Drive 启动 |
| Planned/Processing/Blocking（有非 pending tasks） | 有未完成任务 → Drive 启动 |
| Completed | 展示摘要，提示 merge |
| Merged | 展示归档 |

**用户指令**（修改 body 前必须先 `bot_get_goal` 获取最新版本）：

- 完成/添加子任务 → 更新 body + progress/next
- 记录决策 → 追加到决策记录（带日期）
- 方向变更 → 废弃任务移存档 + 记录决策
- 状态变更 → `bot_update_goal(status=...)`

---

## Drive 启动

所有需要启动 Drive 的地方统一使用此流程：

1. 构建 tasks：优先用 API 返回的 `tasks`，为空则从 body 解析 `[代码]`/`[调研]` 类型，过滤已完成
   ```json
   [{"id":"t1","name":"描述","type":"code|research","complexity":"simple|complex","depends":[],"status":"pending"}]
   ```
2. 获取当前 thread ID：`bot_list_tasks()` → 用当前 cwd 匹配 task 的 `cwd` 字段 → 取 `channel_id`
3. 调用：
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"goalName":"<n>","goalThreadId":"<channel_id>","baseCwd":"<cwd>","tasks":<数组>,"maxConcurrent":3}' \
     "http://127.0.0.1:3456/api/goals/<goal-id>/drive"
   ```
4. 成功 → `bot_update_goal(status="Processing")`；失败 → 输出错误，保持原状态，提示重试

