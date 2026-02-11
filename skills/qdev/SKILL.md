---
name: qdev
description: >
  Quick Dev - 快速创建开发分支和任务。通过 tg API fork 当前 topic 的 root topic，
  然后发送任务描述。例如: /qdev 修复统计负数 → fork root topic + 发送消息
version: 3.0.0
---

# Quick Dev - 快速开发任务初始化

通过 Telegram Bot 的本地 API 自动 fork 当前 topic 的 root topic 并发送任务。

**前置条件**: Telegram Bot 必须正在运行且 API 可用 (`http://127.0.0.1:3456`)。

## 第一步：生成分支名

根据用户描述生成分支名（格式: `<type>/<kebab-case>`）：

- **type**: `feat`(新功能), `fix`(修复), `refactor`(重构), `perf`(性能), `docs`(文档), `test`(测试), `chore`(工程化)
- **kebab-case**: 小写字母+连字符，2-4 个单词

示例:
| 输入 | 分支名 |
|------|--------|
| 修复统计负数 | `fix/stats-negative-value` |
| 添加日志功能 | `feat/logging-system` |
| 优化查询性能 | `perf/query-optimization` |

## 第二步：用一个 bash 脚本完成全部 API 操作

**重要：用一个 bash 脚本完成全部操作，不要分步执行。** 将生成的分支名和用户描述填入下面的脚本，一次性运行：

```bash
#!/bin/bash
set -e

API="http://127.0.0.1:3456"
BRANCH="<生成的分支名>"
DESCRIPTION="<用户的原始描述>"
CWD="$(pwd)"

echo "=== Step 1: 查找当前 topic ==="
TOPICS=$(curl -sf "$API/api/topics") || { echo "❌ API 不可用，请检查 Bot 是否运行"; exit 1; }

# 找到 cwd 匹配的 topic
CURRENT_TOPIC=$(echo "$TOPICS" | jq -r --arg cwd "$CWD" '.data[] | select(.cwd == $cwd)')
if [ -z "$CURRENT_TOPIC" ] || [ "$CURRENT_TOPIC" = "null" ]; then
  echo "❌ 当前目录不在任何 topic 的工作目录中"
  exit 1
fi
CURRENT_ID=$(echo "$CURRENT_TOPIC" | jq -r '.topic_id')
CURRENT_NAME=$(echo "$CURRENT_TOPIC" | jq -r '.name // "unnamed"')
echo "当前 topic: $CURRENT_NAME (ID: $CURRENT_ID)"

echo "=== Step 2: 查找 root topic ==="
ROOT_ID="$CURRENT_ID"
ROOT_NAME="$CURRENT_NAME"
while true; do
  PARENT_ID=$(echo "$TOPICS" | jq -r --arg id "$ROOT_ID" '.data[] | select(.topic_id == ($id | tonumber)) | .parent_topic_id // empty')
  if [ -z "$PARENT_ID" ] || [ "$PARENT_ID" = "null" ]; then
    break
  fi
  ROOT_ID="$PARENT_ID"
  ROOT_NAME=$(echo "$TOPICS" | jq -r --arg id "$ROOT_ID" '.data[] | select(.topic_id == ($id | tonumber)) | .name // "unnamed"')
done
echo "Root topic: $ROOT_NAME (ID: $ROOT_ID)"

echo "=== Step 3: Fork root topic ==="
FORK_RESP=$(curl -sf -X POST "$API/api/topics/$ROOT_ID/fork" \
  -H 'Content-Type: application/json' \
  -d "{\"branch\": \"$BRANCH\"}") || { echo "❌ Fork 失败"; exit 1; }
FORK_TOPIC_ID=$(echo "$FORK_RESP" | jq -r '.data.topic_id')
FORK_TOPIC_NAME=$(echo "$FORK_RESP" | jq -r '.data.name // "unnamed"')
if [ -z "$FORK_TOPIC_ID" ] || [ "$FORK_TOPIC_ID" = "null" ]; then
  echo "❌ Fork 响应中没有 topic_id: $FORK_RESP"
  exit 1
fi
echo "Fork topic: $FORK_TOPIC_NAME (ID: $FORK_TOPIC_ID)"

echo "=== Step 4: 发送任务描述 ==="
MSG_RESP=$(curl -sf -X POST "$API/api/topics/$FORK_TOPIC_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"$DESCRIPTION\"}") || { echo "❌ 发送消息失败"; exit 1; }
echo "消息已发送"

echo ""
echo "===== 完成 ====="
echo "✅ 开发任务已初始化"
echo ""
echo "📋 任务信息"
echo "- Root Topic: $ROOT_NAME"
echo "- Fork Topic: $FORK_TOPIC_NAME"
echo "- 分支: $BRANCH"
echo "- 任务: $DESCRIPTION"
echo ""
echo "🚀 已在 fork topic 中发送任务，Claude 正在处理！"
```

## 重要提示

- **不要询问用户确认**: 直接根据描述生成分支名并执行脚本
- **所有操作通过 curl 调用 API**: 不直接执行 git 命令
- **一个脚本完成全部操作**: 不要拆分成多个命令分步执行
- **如果脚本失败**: 报告具体的错误原因，不要重试

---

**现在请立即执行：先生成分支名，然后将分支名和描述填入脚本并运行。用户提供的描述：{{SKILL_ARGS}}**
