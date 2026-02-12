---
name: goal
description: >
  管理开发目标。无参数列出 Active/Paused Goals；`drive all` 批量启动所有 Active Goals 的自动推进；
  有参数时搜索匹配的 Goal 进入继续模式，没找到则进入创建模式。支持子任务拆解、进度跟踪、方向变更。
version: 1.0.0
---

# Goal - 开发目标管理

管理大型开发目标，支持子任务拆解、进度跟踪和方向变更。

**Goals Database**: `d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`

**Bot API 鉴权**: 所有 Bot API 调用需要 Bearer token。使用前先初始化：

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"
```

所有 curl 请求携带 `-H "$AUTH"`。

## 模式判断

根据 `{{SKILL_ARGS}}` 决定模式：

- **为空** → 列表模式
- **`drive all`** → 批量推进模式
- **不为空（其他）** → 搜索 → 找到则继续模式，没找到则创建模式

---

## 列表模式（无参数）

用 `mcp__claude_ai_Notion__notion-search` 在 Goals database 中搜索 Active 和 Paused 的 Goal。

data_source_url: `collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`

展示格式：

```
📋 当前目标

🟢 Active
  1. <Goal Name> — 进度: <Progress> | 下一步: <Next>
  2. ...

🟡 Paused
  1. <Goal Name> — 卡在: <BlockedBy>
  2. ...

💡 Idea (最近 5 个)
  1. <Idea Name>
  2. ...
```

如果没有任何 Active/Paused Goal，提示用户可以用 `/goal <描述>` 创建新目标或用 `/idea` 记录想法。

---

## 批量推进模式（drive all）

当 `{{SKILL_ARGS}}` 为 `drive all` 时，批量检测并启动所有 Active Goals 的自动推进。

### 流程

1. **查询所有 Active Goals**

   用 `mcp__claude_ai_Notion__notion-search` 搜索 Goals database 中 Status=Active 的 Goal。

   data_source_url: `collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`

2. **逐个处理每个 Active Goal**

   对每个 Active Goal：

   a. 用 `mcp__claude_ai_Notion__notion-fetch` 获取完整页面内容

   b. 检查是否有**未完成的 `[代码]` 或 `[调研]` 子任务**（即 `- [ ]` 且类型为代码或调研）

   c. 如果没有可自动执行的子任务（全部完成或全是手动任务）→ 跳过，记为"无可执行任务"

   d. 如果有 → 按继续模式中的解析规则，将子任务解析为结构化 JSON

   e. 调用 Drive API 启动（需携带 `-H "$AUTH"`）：
      ```bash
      curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
        -d '{"goalName":"<Goal Name>","goalThreadId":"<当前 task 的 thread ID>","baseCwd":"<当前工作目录>","tasks":[解析出的子任务数组],"maxConcurrent":3}' \
        "$API/api/goals/<page-id>/drive"
      ```

   f. 如果 API 返回"已在运行中" → 跳过，记为"已在运行"

   g. 如果 API 返回错误 → 记为失败

3. **汇总输出**

```
🚀 批量推进 Active Goals

✅ <Goal 1> — 已启动 (N 个子任务)
⏭ <Goal 2> — 已在运行中
⏭ <Goal 3> — 无可自动执行的子任务
❌ <Goal 4> — 启动失败: <error>

📊 共 M 个 Active Goals: X 启动, Y 跳过, Z 失败
```

处理完成后**不进入交互模式**，直接结束。用户如需操作单个 Goal，可用 `/goal <name>`。

---

## 搜索匹配

用 `mcp__claude_ai_Notion__notion-search` 搜索匹配的 Goal：

- query: 用户输入的关键词（`{{SKILL_ARGS}}`）
- data_source_url: `collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`

如果找到匹配的 Goal → **继续模式**
如果没找到 → **创建模式**

如果找到多个匹配，列出让用户选择。

---

## 创建模式

### 1. 与用户讨论

和用户一起明确以下信息（通过对话，不要一次性追问全部）：

- **类型**：探索型（不确定最终形态）还是 交付型（明确的交付物）
- **完成标准**：怎样算"做完了"
- **子任务拆解**：拆解到"执行时不需要做判断"的粒度
  - 每个子任务标注类型：`[代码]` / `[手动]` / `[调研]`
  - 代码类子任务注明技术选择
  - 标注依赖关系：`— depends: t1, t2`
  - 可选使用 Phase 分组（Phase N 的任务在 Phase N-1 全部完成后才执行）
- **关键决策**：记录讨论中做出的重要决策

### 2. 写入 Notion

调用 `mcp__claude_ai_Notion__notion-create-pages` 创建：

**数据库字段：**
- **data_source_id**: `d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`
- **Name**: Goal 标题（简短，10 字以内）
- **Status**: `Active`
- **Type**: 探索型 / 交付型
- **Project**: 根据当前工作目录判断
- **date:Date:start**: 今天（ISO-8601）
- **date:Date:is_datetime**: 0
- **Completion**: 完成标准（一句话）
- **Progress**: "0/N 子任务完成"
- **Next**: 第一个待执行的子任务

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
- [ ] `[类型]` t3: 子任务描述 — depends: t1
- [ ] `[类型]` t4: 子任务描述 — depends: t2, t3

▶## 决策记录
	- **<决策主题>**（<日期>）: <决策内容和原因>

▶## 已完成子任务存档
	暂无

▶## 待确认
	暂无
```

### 3. 输出确认

```
🎯 目标已创建: <Goal Name>

📊 子任务: 0/N
🔜 下一步: <第一个子任务>
```

---

## 继续模式

### 1. 读取并展示摘要

用 `mcp__claude_ai_Notion__notion-fetch` 获取 Goal 页面完整内容，展示摘要：

```
🎯 <Goal Name>

📊 进度: <Progress>
🔜 下一步: <Next>
🚧 卡点: <BlockedBy 或 "无">

⏳ 待确认:
  - <如果有待确认事项>
```

### 1.5. 自动推进检测（Drive）

展示摘要后，如果有**未完成的 `[代码]` 或 `[调研]` 子任务**，自动启动 Goal Drive：

1. **解析子任务**为结构化数据：
   ```json
   [
     { "id": "t1", "description": "创建数据模型", "type": "代码", "depends": [], "phase": 1 },
     { "id": "t2", "description": "实现 API", "type": "代码", "depends": ["t1"], "phase": 2 }
   ]
   ```

   解析规则：
   - 子任务 ID: 按出现顺序 t1, t2, t3...
   - type: 从 `[代码]`、`[手动]`、`[调研]` 标注解析，默认为 `代码`
   - depends: 从 `— depends: t1, t2` 解析，或从 Phase 标题推断
   - phase: 从 `## Phase N` 标题推断

2. **调用 Drive API** 启动自动调度（需携带 `-H "$AUTH"`）：
   ```bash
   curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"goalName":"<Goal Name>","goalThreadId":"<当前 task 的 thread ID>","baseCwd":"<当前工作目录>","tasks":[解析出的子任务数组],"maxConcurrent":3}' \
     "$API/api/goals/<page-id>/drive"
   ```

3. **输出启动确认**：
   ```
   🎯 <Goal Name>
   📊 进度: 2/6
   🔜 可并行执行: 3 个子任务

   🚀 自动推进已启动...
   ```

如果 Drive API 返回错误（如已在运行），显示当前状态并等待用户指令。

如果所有子任务都已完成或都是手动任务，跳过自动推进，直接进入用户指令模式。

### 2. 根据用户指令更新

等待用户指令，支持以下操作：

**完成子任务：**
- 用 `mcp__claude_ai_Notion__notion-update-page` 更新页面
- 把完成的子任务从"子任务"移到"已完成子任务存档"，标记为 `[x]`
- 更新"当前状态"区域的进度和下一步
- 更新数据库字段 Progress 和 Next

**添加子任务：**
- 在"子任务"区域追加新的 to-do item

**记录决策：**
- 在"决策记录" toggle 中追加新决策（带日期）

**方向变更：**
- 审查每个现有子任务：保留 / 废弃 / 需修改
- 废弃的子任务移到"已完成子任务存档"，标注 `~~废弃~~` 和原因，**不删除**
- 在"决策记录"中记录方向变更的原因

**标记完成：**
- 更新 Status 为 `Done`
- 更新"当前状态"区域

**标记废弃：**
- 更新 Status 为 `Abandoned`
- 在"决策记录"中记录废弃原因

**标记暂停：**
- 更新 Status 为 `Paused`
- 更新 BlockedBy 字段说明卡点

---

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

---

**现在请立即执行。用户输入：{{SKILL_ARGS}}**
