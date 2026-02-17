#!/bin/bash
# Claude SessionEnd Hook - 当 Claude session 结束时通知 Bot API

INPUT=$(cat)

# 读取 API 端口（从环境变量或默认值）
API_PORT="${API_PORT:-3456}"

# 调用 Bot API（后台执行，不阻塞 Claude）
curl -s -X POST "http://localhost:${API_PORT}/api/internal/hooks/session-event" \
  -H "Content-Type: application/json" \
  -d "$INPUT" &

exit 0
