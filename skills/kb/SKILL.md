---
name: kb
description: >
  知识库管理。无参数列出当前项目的条目；有参数时记录新的经验/教训。
  支持 Markdown 格式，可记录架构决策、排障经验、API 设计要点等。
---

# KB - Knowledge Base 知识库

## 模式判断

根据 `$ARGUMENTS` 决定模式：

- **为空** → 列表模式
- **不为空** → 记录模式

---

## 列表模式（无参数）

### 1. 查询当前项目的知识库条目

```
bot_list_kb(project="<项目名>")
```

### 2. 展示列表

按 category 分组展示：

```
知识库 (项目: <Project>)

Architecture
  1. <Title> — <content 前50字>

Troubleshooting
  2. <Title> — <content 前50字>

(未分类)
  3. <Title> — <content 前50字>

共 N 条。输入编号查看详情，或用 /kb <描述> 记录新条目。
```

如果没有任何条目，提示：`当前项目没有知识库条目。用 /kb <描述> 记录一条经验。`

### 3. 用户选择后

调用 `bot_get_kb(kb_id="<id>")` 获取完整内容并展示。

---

## 记录模式（有参数）

`$ARGUMENTS` 作为初始描述，与用户快速确认以下信息：

### 1. 收集信息

向用户确认：
- **标题**: 从参数提取或请用户精简（≤20字）
- **分类**: 建议一个分类 — Architecture / Troubleshooting / API / Design / Convention / Other
- **内容**: 请用户补充详细内容（Markdown 格式），或根据对话上下文自动整理
- **标签**: 提取相关技术关键词（如 SQLite, migration, Discord.js）
- **来源**: 如果能判断关联的 Goal 或任务，自动填写

如果用户给的参数已经足够详细（超过一句话），直接整理为结构化内容，不追问。

### 2. 写入 SQLite

```
bot_create_kb(
  title="<标题>",
  content="<Markdown 内容>",
  project="<项目名>",
  category="<分类>",
  tags=["tag1", "tag2"],
  source="<来源>"
)
```

### 3. 确认

```
已记录: <标题>
分类: <category> | 标签: tag1, tag2
```

---

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

---

## 重要提示

- 所有操作通过 MCP 工具完成（bot_list_kb, bot_get_kb, bot_create_kb, bot_update_kb, bot_delete_kb）
- 如果 MCP 工具不可用，提示用户检查 Bot 和 MCP Server 是否运行

