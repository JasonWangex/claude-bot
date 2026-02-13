---
name: review
description: >
  自动生成开发日报/周报。从 SQLite 数据库（通过 Bot API）和 Git 收集数据，
  生成结构化回顾，输出到当前对话。支持 daily（默认）和 weekly 模式。
version: 2.0.0
---

# Review - 开发回顾报告

自动收集 DevLog 和 Goals 数据，生成结构化的日报或周报。

## 模式判断

- `{{SKILL_ARGS}}` 为空或包含 "today"/"daily"/"日报" → **日报模式**（默认）
- `{{SKILL_ARGS}}` 包含 "week"/"weekly"/"周报" → **周报模式**
- `{{SKILL_ARGS}}` 包含日期（如 "2026-02-10"）→ 查询指定日期

## 第一步：收集数据

### Bot API 鉴权

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"
```

### 1.1 从 DevLog 收集

通过 Bot API 查询 DevLog：

```bash
# 日报：查询今天的 DevLog
TODAY=$(date +%Y-%m-%d)
curl -s -H "$AUTH" "$API/api/devlogs?date=$TODAY"

# 周报：查询本周的 DevLog
MONDAY=$(date -d "last monday" +%Y-%m-%d 2>/dev/null || date -v-monday +%Y-%m-%d)
curl -s -H "$AUTH" "$API/api/devlogs?start=$MONDAY&end=$TODAY"
```

对搜索到的每条 DevLog 记录，提取：
- name（功能标题）
- project（项目）
- branch（分支）
- summary（摘要）
- commits（commit 数）
- lines_changed（代码变化）
- goal（关联目标）
- content 中的"背景与动机"和"主要变更"

### 1.2 从 Goals 收集

```bash
# 查询 Active Goals
curl -s -H "$AUTH" "$API/api/goals?status=Active"
```

对每个 Active Goal 提取：
- name、progress、next、blocked_by（通过 Goal 详情 API 获取）

### 1.3 从 Git 补充

运行 git 命令补充未走 merge 流程的直接提交：

```bash
# 日报：今天的 commit
git log --since="today 00:00" --pretty=format:"- %h %s (%ar)" --all

# 周报：本周的 commit
git log --since="last monday" --pretty=format:"- %h %s (%ar)" --all
```

## 第二步：生成报告

### 日报格式

```
📊 日报 — <日期>

## 今日完成
（从 DevLog 条目生成，按项目分组）

### <项目名>
- **<功能标题>**: <Summary>
  分支: <branch> | <commits> commits | <lines changed>

（如无 DevLog，写"今天没有合并记录"）

## 目标进度
（从 Goals 生成）

- 🎯 <Goal Name>: <Progress> — 下一步: <Next>
- 🚧 <Goal Name>: <Progress> — 卡在: <BlockedBy>

（如无 Active Goal，写"当前没有活跃目标"）

## Git 活动
（补充 DevLog 之外的 commit，如直接提交到 main 的）

<git log 输出>

（如所有 commit 都已在 DevLog 中，写"所有变更已记录在 DevLog 中"）

## 经验与收获
（从今天的 DevLog Content 中提取值得记住的模式、踩坑、架构决策。
  如果没有特别值得记录的，写"无特别记录"）
```

### 周报格式

```
📊 周报 — <起始日期> ~ <结束日期>

## 本周概览
（用 2-3 句话总结本周整体工作，不是罗列，而是讲述"这周在做什么方向的事"）

## 完成项
（按项目分组，每个项目列出本周的 DevLog 条目）

### <项目名>
- **<功能标题>**: <Summary>
- **<功能标题>**: <Summary>

统计: <N> 项合并, <总 commits> commits, <总 lines changed>

## 目标进展
（对比每个 Goal 本周的变化）

- 🎯 <Goal Name>: <本周进度变化> — 下一步: <Next>

## 本周经验
（汇总本周所有 DevLog 中值得记住的模式和经验）

## 下周方向
（根据 Goals 的 Next 和 BlockedBy 推断下周可能的工作方向）
```

## 输出

直接在当前对话中输出报告内容。不写入数据库（报告本身不持久化，DevLog 已经是持久化的）。

**立即执行。参数：{{SKILL_ARGS}}**
