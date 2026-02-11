#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICES="claude-telegram claude-monitor"

if [ ! -f prd.env ]; then
  echo "Missing prd.env. Please create it from env.example."
  exit 1
fi

link_env() {
  ln -sf prd.env .env
}

install_cron() {
  local cron_line="0 9 * * * $(pwd)/scripts/daily-review.sh"
  if crontab -l 2>/dev/null | grep -qF "daily-review.sh"; then
    echo "  daily-review cron: already installed"
  else
    (crontab -l 2>/dev/null; echo "$cron_line") | crontab -
    echo "  daily-review cron: installed (09:00 daily)"
  fi
}

stamp_deploy_time() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if grep -q '^DEPLOY_TIME=' prd.env 2>/dev/null; then
    sed -i "s/^DEPLOY_TIME=.*/DEPLOY_TIME=${ts}/" prd.env
  else
    echo "DEPLOY_TIME=${ts}" >> prd.env
  fi
  echo "  DEPLOY_TIME=${ts}"
}

do_deploy() {
  link_env
  stamp_deploy_time

  echo "==> Installing skills..."
  bash scripts/install-skills.sh

  echo "==> Installing cron jobs..."
  install_cron

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
  link_env
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
  link_env
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
  journalctl --user -u claude-telegram -u claude-monitor -f
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
    echo "  logs     Follow logs (telegram + monitor)"
    exit 1
    ;;
esac
