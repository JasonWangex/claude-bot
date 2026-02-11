---
name: qdev
description: >
  Quick Dev - 快速创建开发分支和任务。通过 tg API fork 当前 topic 的 root topic，
  然后发送任务描述。例如: /qdev 修复统计负数 → fork root topic + 发送消息
version: 4.0.0
---

# Quick Dev - 快速开发任务初始化

通过 Bot API 一键创建开发分支、fork topic 并触发 Claude 处理。

**前置条件**: Telegram Bot 必须正在运行且 API 可用 (`http://127.0.0.1:3456`)。

## 执行步骤

### 1. 查找当前 topic

```bash
TOPICS=$(curl -sf "http://127.0.0.1:3456/api/topics") || { echo "❌ API 不可用"; exit 1; }
TOPIC_ID=$(echo "$TOPICS" | jq -r --arg cwd "$(pwd)" '[.data[] | select(.cwd == $cwd)] | .[0].topic_id // empty')
[ -n "$TOPIC_ID" ] && echo "当前 topic ID: $TOPIC_ID" || { echo "❌ 当前目录不在任何 topic 中"; exit 1; }
```

### 2. 调用 qdev API

```bash
curl -sf -X POST "http://127.0.0.1:3456/api/topics/$TOPIC_ID/qdev" \
  -H 'Content-Type: application/json' \
  -d '{"description": "<用户的原始描述>"}'
```

API 会自动完成：生成分支名 → fork root topic → 创建 worktree → 发送任务 → 触发 Claude。

## 重要提示

- **禁止一切调查和修复行为**: 你的唯一职责是调用 API 创建任务。绝对不要阅读代码、分析问题、搜索文件
- **不要询问用户确认**: 直接执行
- **如果 API 调用失败**: 报告具体的错误原因，不要重试

---

**现在请立即执行：先查找当前 topic ID，然后调用 qdev API。用户描述：{{SKILL_ARGS}}**
