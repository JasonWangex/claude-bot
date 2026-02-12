---
name: qdev
description: >
  Quick Dev - 快速创建开发分支和任务。通过 Bot API fork 当前 task 的 root task，
  然后发送任务描述。例如: /qdev 修复统计负数 → fork root task + 发送消息
version: 5.0.0
---

# Quick Dev - 快速开发任务初始化

通过 Bot API 一键创建开发分支、fork task 并触发 Claude 处理。

**前置条件**: Discord Bot 必须正在运行且 API 可用 (`http://127.0.0.1:3456`)。

## 执行步骤

### 1. 查找当前 task

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"

TASKS=$(curl -sf -H "$AUTH" "$API/api/tasks") || { echo "API 不可用"; exit 1; }
TASK_ID=$(echo "$TASKS" | jq -r --arg cwd "$(pwd)" '[.data[] | select(.cwd == $cwd)] | .[0].thread_id // empty')
[ -n "$TASK_ID" ] && echo "当前 task ID: $TASK_ID" || { echo "当前目录不在任何 task 中"; exit 1; }
```

### 2. 调用 qdev API

```bash
curl -sf -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"description": "<用户的原始描述>"}' "$API/api/tasks/$TASK_ID/qdev"
```

API 会自动完成：生成分支名 → fork root task → 创建 worktree → 发送任务 → 触发 Claude。

## 重要提示

- **禁止一切调查和修复行为**: 你的唯一职责是调用 API 创建任务。绝对不要阅读代码、分析问题、搜索文件
- **不要询问用户确认**: 直接执行
- **如果 API 调用失败**: 报告具体的错误原因，不要重试

---

**现在请立即执行：先查找当前 task ID，然后调用 qdev API。用户描述：{{SKILL_ARGS}}**
