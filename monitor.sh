#!/bin/bash
#
# Claude 进程监控守护进程启动脚本
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 加载环境变量
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

echo "=========================================="
echo "  Claude Process Monitor"
echo "=========================================="
echo "Environment: .env"
echo "Check Interval: ${MONITOR_CHECK_INTERVAL:-5000}ms"
echo "Cooldown Period: ${MONITOR_COOLDOWN:-180000}ms"
echo "=========================================="
echo ""

# 检查必需的环境变量
if [ -z "$DISCORD_TOKEN" ]; then
  echo "❌ Error: DISCORD_TOKEN not set"
  exit 1
fi

# 编译 TypeScript
echo "📦 Building monitor..."
npx tsx monitor/index.ts
