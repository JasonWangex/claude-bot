---
name: review
description: >
  自动生成开发日报/周报。从 Notion Dev Log 和 Goals 收集数据，
  生成结构化回顾，输出到当前对话。支持 daily（默认）和 weekly 模式。
version: 1.0.0
---

# Review - 开发回顾报告

自动收集 Notion Dev Log 和 Goals 数据，生成结构化的日报或周报。

**数据源：**
- Dev Log: `collection://c1d6130c-fff9-47eb-a525-b53534a3c215`
- Goals: `collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`

## 模式判断

- `{{SKILL_ARGS}}` 为空或包含 "today"/"daily"/"日报" → **日报模式**（默认）
- `{{SKILL_ARGS}}` 包含 "week"/"weekly"/"周报" → **周报模式**
- `{{SKILL_ARGS}}` 包含日期（如 "2026-02-10"）→ 查询指定日期

## 第一步：收集数据

### 1.1 从 Dev Log 收集

用 `mcp__claude_ai_Notion__notion-search` 搜索 Dev Log：

- **data_source_url**: `collection://c1d6130c-fff9-47eb-a525-b53534a3c215`
- **query**: 根据模式选择关键词（项目名、日期范围等）
- **filters**: 按日期范围过滤
  - 日报: `created_date_range` 为今天
  - 周报: `created_date_range` 为本周一到今天

对搜索到的每条 Dev Log 记录，用 `mcp__claude_ai_Notion__notion-fetch` 获取详情，提取：
- Name（功能标题）
- Project（项目）
- Branch（分支）
- Summary（摘要）
- Commits（commit 数）
- Lines Changed（代码变化）
- Goal（关联目标）
- Content 中的"背景与动机"和"主要变更"

### 1.2 从 Goals 收集

用 `mcp__claude_ai_Notion__notion-search` 搜索 Active Goals：

- **data_source_url**: `collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`
- **query**: "Active"

对每个 Active Goal 提取：
- Name、Progress、Next、BlockedBy

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
（从 Dev Log 条目生成，按项目分组）

### <项目名>
- **<功能标题>**: <Summary>
  分支: <branch> | <commits> commits | <lines changed>

（如无 Dev Log，写"今天没有合并记录"）

## 目标进度
（从 Goals 生成）

- 🎯 <Goal Name>: <Progress> — 下一步: <Next>
- 🚧 <Goal Name>: <Progress> — 卡在: <BlockedBy>

（如无 Active Goal，写"当前没有活跃目标"）

## Git 活动
（补充 Dev Log 之外的 commit，如直接提交到 main 的）

<git log 输出>

（如所有 commit 都已在 Dev Log 中，写"所有变更已记录在 Dev Log 中"）

## 经验与收获
（从今天的 Dev Log Content 中提取值得记住的模式、踩坑、架构决策。
  如果没有特别值得记录的，写"无特别记录"）
```

### 周报格式

```
📊 周报 — <起始日期> ~ <结束日期>

## 本周概览
（用 2-3 句话总结本周整体工作，不是罗列，而是讲述"这周在做什么方向的事"）

## 完成项
（按项目分组，每个项目列出本周的 Dev Log 条目）

### <项目名>
- **<功能标题>**: <Summary>
- **<功能标题>**: <Summary>

统计: <N> 项合并, <总 commits> commits, <总 lines changed>

## 目标进展
（对比每个 Goal 本周的变化）

- 🎯 <Goal Name>: <本周进度变化> — 下一步: <Next>

## 本周经验
（汇总本周所有 Dev Log 中值得记住的模式和经验）

## 下周方向
（根据 Goals 的 Next 和 BlockedBy 推断下周可能的工作方向）
```

## 第三步：知识沉淀（P3 自动化）

生成报告时，如果发现以下内容，**自动追加到 Notion 知识库**：

1. **踩过的坑**：开发中遇到的非显而易见的问题和解决方案
2. **有价值的模式**：可复用的代码模式或架构决策
3. **工具/流程改进**：对开发工作流本身的优化

调用 `mcp__claude_ai_Notion__notion-create-pages` 写入知识库：

```json
{
  "parent": {"page_id": "30473f81-21af-8103-aab8-e7771aa6c3da"},
  "pages": [{
    "properties": {"title": "<知识点标题>"},
    "content": "## 场景\n<什么情况下会遇到>\n\n## 要点\n<关键知识点>\n\n## 来源\n<来自哪个 Dev Log / Goal>"
  }]
}
```

**判断标准：** 只记录跨项目/跨场景可复用的经验，不记录纯项目特定的细节。如果本次回顾没有值得沉淀的知识，不写入，不强制。

## 输出

直接在当前对话中输出报告内容。不写入 Notion（报告本身不持久化，Dev Log 和知识库已经是持久化的）。

**立即执行。参数：{{SKILL_ARGS}}**
