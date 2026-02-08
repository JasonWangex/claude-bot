#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICES="claude-web claude-telegram"

if [ ! -f prd.env ]; then
  echo "Missing prd.env. Creating from template..."
  cat > prd.env << 'EOF'
PASSWORD=changeme
JWT_SECRET=change-me-to-a-random-secret
PORT=9000
EOF
  echo "Created prd.env — please edit it before running again."
  exit 1
fi

# 校验默认密码
if grep -qE '^PASSWORD=changeme$|^JWT_SECRET=change-me-to-a-random-secret$' prd.env; then
  echo "ERROR: prd.env contains default passwords. Please change PASSWORD and JWT_SECRET."
  exit 1
fi

link_env() {
  ln -sf prd.env .env
}

do_deploy() {
  echo "==> Building frontend..."
  npm run build

  link_env

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
  journalctl --user -u claude-web -u claude-telegram -f
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
    echo "  deploy   Build frontend + start/restart services"
    echo "  start    Start services"
    echo "  stop     Stop services"
    echo "  restart  Restart services"
    echo "  status   Show service status"
    echo "  logs     Follow logs (web + telegram)"
    exit 1
    ;;
esac
