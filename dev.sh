#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dev.env ]; then
  echo "Missing dev.env file. Please create it from env.example."
  exit 1
fi

# 软链接 dev.env -> .env，让 dotenv 加载正确的配置
ln -sf dev.env .env

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Kill previous dev instance
killed=false
pids=$(pgrep -f "tsx.*telegram/index.ts" 2>/dev/null || true)
if [ -n "$pids" ]; then
  echo "Stopping previous Telegram Bot process..."
  echo "$pids" | xargs kill 2>/dev/null || true
  killed=true
  sleep 1
fi

echo "Starting Claude Telegram Bot..."
exec npm run dev
