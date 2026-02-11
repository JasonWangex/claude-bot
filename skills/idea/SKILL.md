---
name: idea
description: >
  快速记录想法或推进已有想法到开发。有参数时直接记录到 Notion（Status=Idea）；
  无参数时列出当前项目的未开发 Ideas，选中后标记 Processing 并走 qdev 流程。
version: 2.0.0
---

# Idea - 想法管理

## 模式判断

根据 `{{SKILL_ARGS}}` 决定模式：

- **不为空** → 记录模式（写入新 Idea）
- **为空** → 列表模式（查看并推进已有 Idea）

---

## 记录模式（有参数）

将一句话想法直接写入 Notion Goals database，Status 设为 Idea。

**不讨论、不确认、不追问**，直接调用 `mcp__claude_ai_Notion__notion-create-pages` 写入：

- **data_source_id**: `d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`
- **Name**: 用户的原始输入（`{{SKILL_ARGS}}`）
- **Status**: `Idea`
- **Project**: 根据当前工作目录判断（`claude-bot` / `LearnFlashy` / 目录名）
- **date:Date:start**: 今天的日期（ISO-8601）
- **date:Date:is_datetime**: 0

写入成功后，简短确认：

```
💡 已记录: <想法标题>
```

---

## 列表模式（无参数）

### 1. 查询未开发的 Ideas

用 `mcp__claude_ai_Notion__notion-search` 在 Goals database 中查询：

- data_source_url: `collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`
- 筛选 **Status = Idea**
- 只显示当前项目的 Ideas（根据 cwd 判断 Project: `claude-bot` / `LearnFlashy` / 目录名）

### 2. 展示列表

```
💡 未开发的 Ideas (项目: <Project>)

1. <Idea Name>
2. <Idea Name>
3. <Idea Name>
...

输入编号选择要开发的 Idea，或 0 退出
```

如果没有任何 Idea，提示：

```
当前项目没有未开发的 Idea。用 /idea <描述> 记录一个新想法。
```

### 3. 用户选择后推进

用户输入编号后：

#### 3.1 更新 Notion 状态

用 `mcp__claude_ai_Notion__notion-update-page` 将选中 Idea 的 Status 改为 `Processing`。

#### 3.2 执行 qdev 流程

用选中 Idea 的 Name 作为任务描述，执行以下步骤：

**生成分支名：**

根据任务描述生成分支名（格式: `<type>/<kebab-case>`）：

- **type**: `feat`(新功能), `fix`(修复), `refactor`(重构), `perf`(性能), `docs`(文档), `test`(测试), `chore`(工程化)
- **kebab-case**: 小写字母+连字符，2-4 个单词

**查找 root topic：**

```bash
API="http://127.0.0.1:3456"
curl -s $API/api/topics
```

从返回的 topic 列表中：
1. 用当前工作目录 (`pwd`) 匹配 topic 的 `cwd` 字段，找到**当前 topic**
2. 如果当前 topic 有 `parent_topic_id`，沿着 parent 链向上查找，直到找到没有 `parent_topic_id` 的 topic — 这就是 **root topic**
3. 如果当前 topic 没有 `parent_topic_id`，它自己就是 root topic

**Fork root topic：**

```bash
curl -s -X POST $API/api/topics/<ROOT_TOPIC_ID>/fork \
  -H 'Content-Type: application/json' \
  -d '{"branch": "<生成的分支名>"}'
```

从响应中获取 `data.topic_id` 作为新 fork 的 topic ID。

**发送任务描述：**

```bash
curl -s -X POST $API/api/topics/<FORK_TOPIC_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "<Idea 的 Name>"}'
```

#### 3.3 输出确认

```
✅ Idea 已推进到开发

📋 **任务信息**
- Idea: <Idea Name>
- Root Topic: <root topic name>
- Fork Topic: <fork topic name>
- 分支: `<branch>`
- Notion 状态: Processing

🚀 已在 fork topic 中发送任务，Claude 正在处理！
```

## 重要提示

- **记录模式**: 不讨论、不确认，直接写入
- **列表模式**: 列出后等待用户选择，选择后不再确认，直接推进
- **所有 API 操作通过 curl**: 不直接执行 git 命令
- **如果 API 不可用**: 提示用户检查 Bot 是否运行
- **如果找不到匹配的 topic**: 提示用户当前目录不在任何 topic 的工作目录中

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

---

**现在请立即执行。用户输入：{{SKILL_ARGS}}**
