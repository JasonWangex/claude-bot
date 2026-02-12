#!/usr/bin/env bash
# config.sh — Claude Discord Bot interactive setup
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_DIR="$(pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# ========== Colors ==========
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

prompt_value() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local value
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} [$default]: ")" value
    value="${value:-$default}"
  else
    read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" value
  fi
  eval "$var_name=\"\$value\""
}

prompt_secret() {
  local var_name="$1" prompt="$2"
  local value
  read -rsp "$(echo -e "${BOLD}$prompt${NC}: ")" value
  echo ""
  eval "$var_name=\"\$value\""
}

# ========== check_deps ==========
check_deps() {
  echo -e "\n${BOLD}==> Checking dependencies${NC}"
  local ok=true

  # Node.js >= 18
  if command -v node &>/dev/null; then
    local node_ver
    node_ver="$(node -v | sed 's/v//')"
    local major="${node_ver%%.*}"
    if [ "$major" -ge 18 ]; then
      ok "Node.js $node_ver"
    else
      err "Node.js $node_ver (need >= 18)"
      ok=false
    fi
  else
    err "Node.js not found"
    ok=false
  fi

  # npm
  if command -v npm &>/dev/null; then
    ok "npm $(npm -v)"
  else
    err "npm not found"
    ok=false
  fi

  # git
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}')"
  else
    err "git not found"
    ok=false
  fi

  # Claude CLI
  if command -v claude &>/dev/null; then
    ok "Claude CLI found"
  else
    warn "Claude CLI not found (install: npm install -g @anthropic-ai/claude-code)"
  fi

  # tsx
  if npx tsx --version &>/dev/null 2>&1; then
    ok "tsx available"
  else
    warn "tsx not found (will be installed with npm install)"
  fi

  if ! $ok; then
    err "Missing required dependencies. Please install them first."
    exit 1
  fi
}

# ========== setup_discord ==========
setup_discord() {
  echo -e "\n${BOLD}==> Discord Configuration${NC}"
  echo "Get your bot token from https://discord.com/developers/applications"
  echo ""

  prompt_secret DISCORD_TOKEN "Discord Bot Token"
  if [ -z "$DISCORD_TOKEN" ]; then
    err "Discord Token is required"
    exit 1
  fi

  prompt_value DISCORD_APPLICATION_ID "Discord Application ID"
  if [ -z "$DISCORD_APPLICATION_ID" ]; then
    err "Application ID is required"
    exit 1
  fi

  prompt_secret BOT_ACCESS_TOKEN "Bot Access Token (for API auth)"
  if [ -z "$BOT_ACCESS_TOKEN" ]; then
    err "Access Token is required"
    exit 1
  fi

  prompt_value AUTHORIZED_GUILD_ID "Authorized Guild ID (optional)" ""
  prompt_value GENERAL_CHANNEL_ID "General Channel ID (optional)" ""

  ok "Discord configuration done"
}

# ========== setup_paths ==========
setup_paths() {
  echo -e "\n${BOLD}==> Path Configuration${NC}"

  prompt_value DEFAULT_WORK_DIR "Default working directory" "$HOME/assistant"
  prompt_value PROJECTS_ROOT "Projects root" "$HOME/projects"
  prompt_value WORKTREES_DIR "Worktrees directory" "$HOME/projects/worktrees"

  ok "Path configuration done"
}

# ========== setup_optional ==========
setup_optional() {
  echo -e "\n${BOLD}==> Optional Configuration${NC}"

  prompt_value DEEPSEEK_API_KEY "DeepSeek API Key (for branch name generation, optional)" ""
  prompt_value API_PORT "Local HTTP API port (0 to disable)" "3456"
  prompt_value COMMAND_TIMEOUT "Command timeout in ms" "3600000"
  prompt_value MAX_TURNS "Max execution turns" "500"

  echo ""
  read -rp "$(echo -e "${BOLD}Configure proxy? (y/N)${NC}: ")" use_proxy
  if [[ "$use_proxy" =~ ^[Yy] ]]; then
    prompt_value HTTP_PROXY "HTTP proxy" "http://127.0.0.1:7890"
    HTTPS_PROXY="$HTTP_PROXY"
  else
    HTTP_PROXY=""
    HTTPS_PROXY=""
  fi

  ok "Optional configuration done"
}

# ========== generate_env ==========
generate_env() {
  echo -e "\n${BOLD}==> Generating .env file${NC}"

  if [ -f "$ENV_FILE" ]; then
    read -rp "$(echo -e "${YELLOW}.env already exists. Overwrite? (y/N)${NC}: ")" overwrite
    if [[ ! "$overwrite" =~ ^[Yy] ]]; then
      info "Skipping .env generation"
      return
    fi
    cp "$ENV_FILE" "$ENV_FILE.bak"
    info "Backed up existing .env to .env.bak"
  fi

  cat > "$ENV_FILE" << EOF
# --- Discord Bot ---
DISCORD_TOKEN=${DISCORD_TOKEN}
DISCORD_APPLICATION_ID=${DISCORD_APPLICATION_ID}
BOT_ACCESS_TOKEN=${BOT_ACCESS_TOKEN}
AUTHORIZED_GUILD_ID=${AUTHORIZED_GUILD_ID:-}
GENERAL_CHANNEL_ID=${GENERAL_CHANNEL_ID:-}
DEFAULT_WORK_DIR=${DEFAULT_WORK_DIR}
PROJECTS_ROOT=${PROJECTS_ROOT}
WORKTREES_DIR=${WORKTREES_DIR}

# Claude CLI
COMMAND_TIMEOUT=${COMMAND_TIMEOUT:-3600000}
MAX_TURNS=${MAX_TURNS:-500}

# DeepSeek API
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}

# Local HTTP API
API_PORT=${API_PORT:-3456}

# Proxy
http_proxy=${HTTP_PROXY:-}
https_proxy=${HTTPS_PROXY:-}

# Monitor
MONITOR_CHECK_INTERVAL=5000
MONITOR_COOLDOWN=180000
MONITOR_MIN_RUNTIME=2
MONITOR_MAX_RUNTIME=3600
MONITOR_SERVICES=claude-discord
EOF

  chmod 600 "$ENV_FILE"
  ok ".env created (permissions: 600)"
}

# ========== install_deps ==========
install_deps() {
  echo -e "\n${BOLD}==> Installing npm dependencies${NC}"
  npm install
  ok "Dependencies installed"
}

# ========== install_skills ==========
install_skills() {
  echo -e "\n${BOLD}==> Installing skills${NC}"

  if [ -x "$PROJECT_DIR/scripts/install-skills.sh" ]; then
    bash "$PROJECT_DIR/scripts/install-skills.sh"
  else
    local SKILLS_SRC="$PROJECT_DIR/skills"
    local SKILLS_DST="$HOME/.claude/skills"

    if [ ! -d "$SKILLS_SRC" ]; then
      info "No skills/ directory found, skipping"
      return
    fi

    mkdir -p "$SKILLS_DST"

    local count=0
    for skill_dir in "$SKILLS_SRC"/*/; do
      [ -d "$skill_dir" ] || continue
      [ -f "$skill_dir/SKILL.md" ] || continue

      local skill_name
      skill_name="$(basename "$skill_dir")"
      local target="$SKILLS_DST/$skill_name"

      if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$(readlink -f "$skill_dir")" ]; then
        info "$skill_name: already linked"
      else
        rm -rf "$target"
        ln -s "$(readlink -f "$skill_dir")" "$target"
        ok "$skill_name: installed -> $target"
      fi
      count=$((count + 1))
    done

    ok "Skills installed: $count"
  fi
}

# ========== setup_service ==========
setup_service() {
  echo -e "\n${BOLD}==> Configuring systemd services${NC}"

  local SERVICE_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_DIR"

  local NODE_PATH
  NODE_PATH="$(which node)"
  local TSX_PATH="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
  local ENV_PATH="$HOME/.local/bin:$PROJECT_DIR/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"

  # claude-discord.service
  cat > "$SERVICE_DIR/claude-discord.service" << EOF
[Unit]
Description=Claude Discord Bot
After=network.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=NODE_ENV=production
Environment=PATH=$ENV_PATH
ExecStart=$NODE_PATH $TSX_PATH discord/index.ts
KillMode=process
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=claude-discord

[Install]
WantedBy=default.target
EOF
  ok "claude-discord.service created"

  # claude-monitor.service
  cat > "$SERVICE_DIR/claude-monitor.service" << EOF
[Unit]
Description=Claude Process Monitor
After=network.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=NODE_ENV=production
Environment=PATH=$ENV_PATH
ExecStart=$NODE_PATH $TSX_PATH monitor/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=claude-monitor

[Install]
WantedBy=default.target
EOF
  ok "claude-monitor.service created"

  systemctl --user daemon-reload
  ok "systemd daemon reloaded"

  echo ""
  read -rp "$(echo -e "${BOLD}Enable and start services now? (y/N)${NC}: ")" start_now
  if [[ "$start_now" =~ ^[Yy] ]]; then
    for svc in claude-discord claude-monitor; do
      systemctl --user enable "$svc"
      systemctl --user restart "$svc"
    done
    sleep 2
    for svc in claude-discord claude-monitor; do
      if systemctl --user is-active --quiet "$svc"; then
        ok "$svc: running"
      else
        err "$svc: FAILED"
        journalctl --user -u "$svc" -n 5 --no-pager
      fi
    done
  else
    info "Services created but not started. Use: systemctl --user start claude-discord"
  fi
}

# ========== do_verify ==========
do_verify() {
  echo -e "\n${BOLD}==> Verifying configuration${NC}"
  local ok=true

  # .env file
  if [ -f "$ENV_FILE" ]; then
    ok ".env file exists"
  else
    err ".env file not found. Run: ./config.sh env"
    ok=false
  fi

  # Required env vars
  if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE" 2>/dev/null || true
    for var in DISCORD_TOKEN DISCORD_APPLICATION_ID BOT_ACCESS_TOKEN DEFAULT_WORK_DIR; do
      if [ -n "${!var:-}" ]; then
        ok "$var is set"
      else
        err "$var is empty or missing"
        ok=false
      fi
    done
  fi

  # Node modules
  if [ -d "node_modules" ]; then
    ok "node_modules exists"
  else
    err "node_modules not found. Run: ./config.sh deps"
    ok=false
  fi

  # discord.js
  if [ -d "node_modules/discord.js" ]; then
    ok "discord.js installed"
  else
    err "discord.js not found"
    ok=false
  fi

  # Claude CLI
  if command -v claude &>/dev/null; then
    ok "Claude CLI available"
  else
    warn "Claude CLI not found"
  fi

  # TypeScript compilation
  if npx tsc --noEmit &>/dev/null 2>&1; then
    ok "TypeScript compiles successfully"
  else
    warn "TypeScript compilation has errors (run: npx tsc --noEmit)"
  fi

  # Skills
  local skills_dst="$HOME/.claude/skills"
  if [ -d "$skills_dst" ]; then
    local skill_count
    skill_count="$(find "$skills_dst" -maxdepth 1 -type l | wc -l)"
    ok "Skills directory exists ($skill_count linked)"
  else
    warn "Skills directory not found. Run: ./config.sh skills"
  fi

  # systemd services
  local service_dir="$HOME/.config/systemd/user"
  for svc in claude-discord claude-monitor; do
    if [ -f "$service_dir/$svc.service" ]; then
      if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
        ok "$svc.service: active"
      else
        warn "$svc.service: installed but not running"
      fi
    else
      warn "$svc.service: not installed. Run: ./config.sh service"
    fi
  done

  echo ""
  if $ok; then
    ok "All checks passed"
  else
    err "Some checks failed. See above."
  fi
}

# ========== do_init ==========
do_init() {
  echo -e "${BOLD}"
  echo "╔═══════════════════════════════════════╗"
  echo "║   Claude Discord Bot Setup Wizard     ║"
  echo "╚═══════════════════════════════════════╝"
  echo -e "${NC}"

  check_deps
  setup_discord
  setup_paths
  setup_optional
  generate_env
  install_deps
  install_skills
  setup_service
  do_verify

  echo -e "\n${GREEN}${BOLD}Setup complete!${NC}"
  echo -e "Use ${CYAN}./deploy.sh deploy${NC} for future deployments."
  echo -e "Use ${CYAN}./deploy.sh logs${NC} to view logs."
}

# ========== Main ==========
case "${1:-init}" in
  init)     do_init ;;
  discord)  setup_discord; echo "Run './config.sh env' next to update .env" ;;
  env)
    # Load existing values for defaults
    DISCORD_TOKEN="${DISCORD_TOKEN:-}"
    DISCORD_APPLICATION_ID="${DISCORD_APPLICATION_ID:-}"
    BOT_ACCESS_TOKEN="${BOT_ACCESS_TOKEN:-}"
    AUTHORIZED_GUILD_ID="${AUTHORIZED_GUILD_ID:-}"
    GENERAL_CHANNEL_ID="${GENERAL_CHANNEL_ID:-}"
    DEFAULT_WORK_DIR="${DEFAULT_WORK_DIR:-$HOME/assistant}"
    PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"
    WORKTREES_DIR="${WORKTREES_DIR:-$HOME/projects/worktrees}"
    DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
    API_PORT="${API_PORT:-3456}"
    COMMAND_TIMEOUT="${COMMAND_TIMEOUT:-3600000}"
    MAX_TURNS="${MAX_TURNS:-500}"
    HTTP_PROXY="${http_proxy:-}"
    HTTPS_PROXY="${https_proxy:-}"
    if [ -z "$DISCORD_TOKEN" ] || [ -z "$BOT_ACCESS_TOKEN" ]; then
      setup_discord
    fi
    if [ -z "$DEFAULT_WORK_DIR" ]; then
      setup_paths
    fi
    generate_env
    ;;
  deps)     install_deps ;;
  skills)   install_skills ;;
  service)  setup_service ;;
  verify)   do_verify ;;
  *)
    echo "Usage: ./config.sh [command]"
    echo ""
    echo "Commands:"
    echo "  init      Interactive full setup (default)"
    echo "  discord   Configure Discord Token and Application ID"
    echo "  env       Generate/update .env file"
    echo "  deps      Install npm dependencies"
    echo "  skills    Install skill symlinks"
    echo "  service   Configure systemd services"
    echo "  verify    Verify configuration completeness"
    exit 1
    ;;
esac
