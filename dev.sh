#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dev.env ]; then
  echo "Missing dev.env file. Creating from template..."
  cat > dev.env << 'EOF'
PASSWORD=changeme
JWT_SECRET=change-me-to-a-random-secret
PORT=9000
EOF
  echo "Created dev.env — please edit it before running again."
  exit 1
fi

# 软链接 dev.env -> .env，让 dotenv 加载正确的配置
ln -sf dev.env .env

if ! command -v tmux &>/dev/null; then
  echo "Error: tmux is required but not installed."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Kill previous dev instance by process name
killed=false
for pattern in "tsx.*server/index.ts" "node.*vite"; do
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Stopping previous processes ($pattern)..."
    echo "$pids" | xargs kill 2>/dev/null || true
    killed=true
  fi
done

# Wait for ports to be fully released
if $killed; then
  PORT=$(grep -oP '^PORT=\K[0-9]+' dev.env 2>/dev/null || echo 9000)
  echo "Waiting for ports to be released..."
  for i in $(seq 1 20); do
    if ! lsof -ti :"$PORT" &>/dev/null && ! lsof -ti :5173 &>/dev/null; then
      break
    fi
    sleep 0.3
  done
fi

exec npm run dev
