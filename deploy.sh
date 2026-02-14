#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_DIR="$(pwd)"
SERVICES="claude-discord claude-monitor claude-mcp claude-web"

if [ ! -f .env ]; then
  echo "Missing .env file. Please create it from example.env."
  exit 1
fi

install_cron() {
  local cron_line="0 9 * * * $(pwd)/scripts/daily-review.sh"
  if crontab -l 2>/dev/null | grep -qF "daily-review.sh"; then
    echo "  daily-review cron: already installed"
  else
    (crontab -l 2>/dev/null; echo "$cron_line") | crontab -
    echo "  daily-review cron: installed (09:00 daily)"
  fi
}

install_hooks() {
  local hook_dir="$HOME/.claude/hooks"
  local hook_src="$PROJECT_DIR/hooks"

  mkdir -p "$hook_dir"

  if [ -d "$hook_src" ]; then
    for f in "$hook_src"/*.sh; do
      [ -f "$f" ] || continue
      local name
      name="$(basename "$f")"
      cp "$f" "$hook_dir/$name"
      chmod +x "$hook_dir/$name"
      echo "  $name: installed"
    done
  fi

  # 更新 Claude settings.json 中的 hooks 配置
  local settings_file="$HOME/.claude/settings.json"
  if [ -f "$settings_file" ]; then
    echo "  Claude settings.json: hooks already configured (manual merge required)"
  else
    echo "  Claude settings.json: not found, skipping hooks configuration"
  fi
}

stamp_deploy_time() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if grep -q '^DEPLOY_TIME=' .env 2>/dev/null; then
    sed -i "s/^DEPLOY_TIME=.*/DEPLOY_TIME=${ts}/" .env
  else
    echo "DEPLOY_TIME=${ts}" >> .env
  fi
  echo "  DEPLOY_TIME=${ts}"
}

install_systemd_services() {
  local svc_src="$PROJECT_DIR/systemd"
  local svc_dst="$HOME/.config/systemd/user"
  mkdir -p "$svc_dst"
  if [ -d "$svc_src" ]; then
    for f in "$svc_src"/*.service; do
      [ -f "$f" ] || continue
      local name
      name="$(basename "$f")"
      cp "$f" "$svc_dst/$name"
      echo "  $name: installed"
    done
  fi
}

do_deploy() {
  stamp_deploy_time

  echo "==> Installing dependencies..."
  pnpm install --frozen-lockfile

  echo "==> Installing skills..."
  bash scripts/install-skills.sh

  echo "==> Building web UI..."
  pnpm --dir web build

  echo "==> Installing systemd services..."
  install_systemd_services

  echo "==> Installing cron jobs..."
  install_cron

  echo "==> Installing Claude hooks..."
  install_hooks

  echo "==> Reloading systemd..."
  systemctl --user daemon-reload

  for svc in $SERVICES; do
    systemctl --user enable "$svc"
    systemctl --user restart "$svc"
  done

  sleep 2
  local ok=true
  for svc in $SERVICES; do
    if systemctl --user is-active --quiet "$svc"; then
      echo "==> $svc: running"
    else
      echo "==> $svc: FAILED"
      journalctl --user -u "$svc" -n 10 --no-pager
      ok=false
    fi
  done

  if $ok; then
    echo "==> Deploy successful"
  else
    echo "==> Deploy had failures"
    exit 1
  fi
}

do_start() {
  for svc in $SERVICES; do
    systemctl --user start "$svc"
    echo "$svc started"
  done
}

do_stop() {
  for svc in $SERVICES; do
    systemctl --user stop "$svc" 2>/dev/null || true
    echo "$svc stopped"
  done
}

do_restart() {
  stamp_deploy_time
  for svc in $SERVICES; do
    systemctl --user restart "$svc"
    echo "$svc restarted"
  done
}

do_status() {
  for svc in $SERVICES; do
    systemctl --user status "$svc" --no-pager 2>/dev/null || echo "$svc: inactive"
    echo ""
  done
}

do_logs() {
  journalctl --user -u claude-discord -u claude-monitor -u claude-mcp -u claude-web -f
}

case "${1:-}" in
  deploy)  do_deploy ;;
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo "Usage: $0 {deploy|start|stop|restart|status|logs}"
    echo ""
    echo "  deploy   Start/restart services"
    echo "  start    Start services"
    echo "  stop     Stop services"
    echo "  restart  Restart services"
    echo "  status   Show service status"
    echo "  logs     Follow logs (discord + monitor + mcp)"
    exit 1
    ;;
esac
