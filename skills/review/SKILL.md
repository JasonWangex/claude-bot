---
name: review
description: >
  自动生成开发日报/周报。从 SQLite 数据库（通过 MCP 工具）和 Git 收集数据，
  生成结构化回顾，输出到当前对话。支持 daily（默认）和 weekly 模式。
---

# Review - 开发回顾报告

自动收集 DevLog 和 Goals 数据，生成结构化的日报或周报。

## 模式判断

- `$ARGUMENTS` 为空或包含 "today"/"daily"/"日报" → **日报模式**（默认）
- `$ARGUMENTS` 包含 "week"/"weekly"/"周报" → **周报模式**
- `$ARGUMENTS` 包含日期（如 "2026-02-10"）→ 查询指定日期

## 第一步：收集数据

### 1.1 从 DevLog 收集

```
# 日报：查询今天的 DevLog
bot_devlogs(action="list", date="<今天 yyyy-MM-dd>")

# 周报：查询本周的 DevLog
bot_devlogs(action="list", start="<本周一 yyyy-MM-dd>", end="<今天 yyyy-MM-dd>")
```

对每条 DevLog 记录，提取：name、project、branch、summary、commits、lines_changed、goal、content

### 1.2 从 Goals 收集

```
bot_goals(action="list", status="Processing")
```

对每个 Processing Goal 提取：name、progress、next、blocked_by

### 1.3 从 Git 补充

运行 git 命令补充未走 merge 流程的直接提交：

```bash
# 日报
git log --since="today 00:00" --pretty=format:"- %h %s (%ar)" --all

# 周报
git log --since="last monday" --pretty=format:"- %h %s (%ar)" --all
```

## 第二步：生成报告

### 日报格式

```
日报 — <日期>

## 今日完成
（从 DevLog 条目生成，按项目分组）

### <项目名>
- **<功能标题>**: <Summary>
  分支: <branch> | <commits> commits | <lines changed>

## 目标进度
- <Goal Name>: <Progress> — 下一步: <Next>
- <Goal Name>: <Progress> — 卡在: <BlockedBy>

## Git 活动
（补充 DevLog 之外的 commit）

## 经验与收获
（从今天的 DevLog Content 中提取值得记住的模式、踩坑、架构决策）
```

### 周报格式

```
周报 — <起始日期> ~ <结束日期>

## 本周概览
（2-3 句话总结整体方向）

## 完成项
（按项目分组列出 DevLog 条目）
统计: <N> 项合并, <总 commits> commits

## 目标进展
- <Goal Name>: <本周进度变化> — 下一步: <Next>

## 本周经验
（汇总值得记住的模式和经验）

## 下周方向
（根据 Goals 的 Next 和 BlockedBy 推断）
```

## 输出

直接在当前对话中输出报告内容。不写入数据库。
