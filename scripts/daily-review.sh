#!/bin/bash
# 每日自动发送日报触发消息到 Telegram General topic
# 通过 Bot API 发送 /review 命令，Claude session 会自动执行 review skill
#
# 安装: crontab -e → 添加:
# 0 9 * * * /home/jason/projects/claude-bot/scripts/daily-review.sh

API="http://127.0.0.1:3456"
TOPIC_ID=6774  # Chat topic

# 检查 Bot API 是否运行
if ! curl -sf "$API/api/health" > /dev/null 2>&1; then
  echo "$(date): Bot API not running, skip daily review" >> /tmp/daily-review.log
  exit 1
fi

# 发送 /review 触发消息
RESP=$(curl -sf -X POST "$API/api/topics/$TOPIC_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"text": "/review"}')

echo "$(date): Daily review triggered. Response: $RESP" >> /tmp/daily-review.log
