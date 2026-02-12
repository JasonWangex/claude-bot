---
name: devlog
description: >
  记录开发日志到本地数据库。可独立调用，也可被 /merge 等 skill 调用。
  自动收集 git 信息，生成功能摘要，通过 HTTP API 写入。用 git tag 追踪进度，避免重复记录。
version: 3.0.0
---

# Dev Log - 开发日志记录

将开发成果通过 Bot HTTP API 记录到本地数据库。

**Bot API 鉴权**: 所有 API 调用需要 Bearer token。使用前先初始化：

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"
```

## 信息收集

根据调用场景，收集以下信息：

### 场景 A：从 /merge 调用（已有信息）

如果上下文中已有 `DEVLOG_` 开头的信息（来自 merge 脚本输出），直接使用：
- `DEVLOG_COMMIT_COUNT` → commit 数量
- `DEVLOG_COMMIT_MESSAGES` → commit 消息列表
- `DEVLOG_DIFF_STAT` → diff 统计

此场景下跳过书签检查（merge 已经明确了范围）。写入成功后仍需更新书签。

### 场景 B：独立调用

用 `devlog/last` tag 作为书签，只收集上次记录之后的新 commit。

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 确定起点：有书签用书签，没有则取最近 20 条
if git rev-parse devlog/last >/dev/null 2>&1; then
  BASE="devlog/last"
else
  echo "DEVLOG_NO_BOOKMARK=true"
  BASE="HEAD~20"  # 首次使用，回溯 20 条作为候选范围
fi

if [ "$BRANCH" != "main" ]; then
  # 功能分支：对比 main（书签不影响，因为分支本身就是天然边界）
  BASE="main"
fi

COMMIT_COUNT=$(git log ${BASE}..HEAD --oneline | wc -l | tr -d ' ')
COMMIT_MESSAGES=$(git log ${BASE}..HEAD --pretty=format:"- %s")
DIFF_STAT=$(git diff --shortstat ${BASE}..HEAD)

echo "Branch: $BRANCH"
echo "Base: $BASE"
echo "Commits: $COMMIT_COUNT"
echo "Messages:"
echo "$COMMIT_MESSAGES"
echo "Diff: $DIFF_STAT"
```

**如果 COMMIT_COUNT 为 0**：告知用户"没有新的提交需要记录"，不执行写入。

**如果 DEVLOG_NO_BOOKMARK=true**（首次使用）：向用户展示收集到的 commit 列表，确认范围是否正确后再写入。

### 额外信息收集（用于生成页面详情）

在场景 A 和 B 的基础上，**额外运行以下命令**收集详细变更信息：

```bash
# 每个文件的变更统计（文件名 + 增删行数）
git diff --stat ${BASE}..HEAD

# 变更文件列表（按类型分类：新增/修改/删除）
git diff --name-status ${BASE}..HEAD

# 带完整 hash 和时间的 commit 日志
git log ${BASE}..HEAD --pretty=format:"%h %s (%ai)"
```

### 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

### Goal 关联

如果当前上下文中能明确判断关联的 Goal（例如分支名包含 goal 关键词、或者是从 Goal Drive 触发的任务），填写 Goal 名称；否则留空。不需要查询 API。

## 通过 HTTP API 写入

调用 `POST /api/devlogs` 写入，请求体为 JSON：

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 根据 commit messages 生成简短的功能标题（中文，10字以内） |
| `date` | string | 是 | 今天的日期（yyyy-MM-dd） |
| `project` | string | 是 | 项目名 |
| `branch` | string | 否 | 分支名 |
| `summary` | string | 否 | 根据 commit messages 用一两句自然语言概括做了什么 |
| `commits` | number | 否 | commit 数量 |
| `lines_changed` | string | 否 | diff stat 原文 |
| `goal` | string | 否 | 关联的 Goal 名称 |
| `content` | string | 否 | Markdown 格式的详细内容 |

### Content（页面正文）

生成 Markdown 格式的详细正文，结构如下：

```
## 背景与动机
（根据 commit messages 和变更内容，用 2-3 句话说明为什么做这次变更。
  描述要解决的问题或要实现的目标。不要重复 Summary，要更深入。）

## 主要变更
（用 bullet list 列出关键变更点，每个点一句话说明做了什么以及为什么。
  不是简单复述 commit message，而是归纳整理，合并相关的 commit。
  如果有架构/设计上的决策，在这里说明。）

- **变更点 1 标题**：具体说明
- **变更点 2 标题**：具体说明
- ...

## Commits
（原始 commit 列表，用代码块展示）

```text
<hash> <message> (<date>)
...
```（反引号结束代码块）

## 文件变更
（用 Markdown 表格展示变更的文件）

| 文件 | 变更 | 说明 |
|------|------|------|
| path/to/file | +20 -5 | 简要说明这个文件的变更内容 |
```

**Content 生成要求：**
1. 语言使用中文
2. "背景与动机"需要体现工程思维，不是简单描述"改了什么"而是"为什么改"
3. "主要变更"应该是经过归纳的，多个相关 commit 合并为一个变更点
4. "文件变更"表格的"说明"列应简要说明每个文件的变更目的，不是文件名的翻译
5. 不要在 content 中重复 Name 作为标题

### 完整示例

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{
    "name": "消息队列优化",
    "date": "2026-02-11",
    "project": "claude-bot",
    "branch": "perf/message-queue",
    "summary": "实现 per-topic 消息节流与合并机制，降低 API rate limit",
    "commits": 3,
    "lines_changed": "5 files changed, 180 insertions(+), 42 deletions(-)",
    "goal": "消息系统优化",
    "content": "## 背景与动机\n高频操作场景下，Bot 向 Discord API 发送消息过于频繁，频繁触发 429 rate limit 导致消息丢失。需要在应用层实现消息节流机制，在保证消息可达性的同时降低 API 调用频率。\n\n## 主要变更\n- **Per-topic 消息节流**：为每个 Discord thread 维护独立的节流队列\n- **消息合并策略**：相同 topic 的连续消息合并为单条发送\n- **错误重试机制**：收到 429 响应后，按 Retry-After header 指定的时间延迟重试\n\n## Commits\n```text\na1b2c3d feat: add per-topic message throttling (2026-02-10 14:30:00 +0800)\nd4e5f6a feat: implement message merge strategy (2026-02-10 15:45:00 +0800)\n7g8h9i0 fix: respect Retry-After header on 429 response (2026-02-11 09:20:00 +0800)\n```\n\n## 文件变更\n| 文件 | 变更 | 说明 |\n|------|------|------|\n| src/services/message-queue.ts | +85 -12 | 新增 ThrottleQueue 类 |\n| src/services/message-merger.ts | +60 -0 | 新增消息合并工具 |\n| src/handlers/send.ts | +15 -8 | 调用方改用 throttled send |"
  }' "$API/api/devlogs"
```

成功响应：

```json
{
  "ok": true,
  "data": {
    "id": "devlog-1707654321000-abc123",
    "name": "消息队列优化",
    "date": "2026-02-11",
    "project": "claude-bot",
    ...
  }
}
```

## 更新书签

**API 写入成功后**（响应 `ok: true`），更新 git tag 书签：

```bash
git tag -f devlog/last HEAD
```

这样下次调用 `/devlog` 时，只会收集这个 tag 之后的新 commit。

写入成功后，输出确认信息。
