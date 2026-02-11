---
name: devlog
description: >
  记录开发日志到 Notion Dev Log 数据库。可独立调用，也可被 /merge 等 skill 调用。
  自动收集 git 信息，生成功能摘要，写入 Notion。用 git tag 追踪进度，避免重复记录。
version: 1.1.0
---

# Dev Log - 开发日志记录

将开发成果记录到 Notion Dev Log 数据库。

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

### 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名（首次使用时会自动添加到 Notion select 选项）

## 写入 Notion

调用 `mcp__claude_ai_Notion__notion-create-pages` 写入：

- **data_source_id**: `c1d6130c-fff9-47eb-a525-b53534a3c215`
- **Name**: 根据 commit messages 生成简短的功能标题（中文，10字以内）
- **date:Date:start**: 今天的日期（ISO-8601）
- **date:Date:is_datetime**: 0
- **Project**: 项目名
- **Branch**: 分支名
- **Summary**: 根据 commit messages 用一两句自然语言概括做了什么
- **Commits**: commit 数量
- **Lines Changed**: diff stat 原文
- **Goal**:（可选）关联的开发目标名称。如果 Notion MCP 可用，尝试用 `mcp__claude_ai_Notion__notion-search` 在 Goals database（`collection://d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`）中搜索 Status=Active 的 Goal，如果 commit 内容明显属于某个 Active Goal 则填写其名称；否则留空。

示例：
```json
{
  "parent": {"data_source_id": "c1d6130c-fff9-47eb-a525-b53534a3c215"},
  "pages": [{
    "properties": {
      "Name": "消息队列优化",
      "date:Date:start": "2026-02-11",
      "date:Date:is_datetime": 0,
      "Project": "claude-bot",
      "Branch": "perf/message-queue",
      "Summary": "实现 per-topic 消息节流与合并机制，降低 Telegram 429 rate limit",
      "Commits": 3,
      "Lines Changed": "5 files changed, 180 insertions(+), 42 deletions(-)",
      "Goal": "消息系统优化"
    }
  }]
}
```

## 更新书签

**写入 Notion 成功后**，更新 git tag 书签：

```bash
git tag -f devlog/last HEAD
```

这样下次调用 `/devlog` 时，只会收集这个 tag 之后的新 commit。

写入成功后，输出确认信息和 Notion 页面链接。
