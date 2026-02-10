# Claude Bot

Telegram Bot for Claude Code CLI integration with process monitoring.

## Features

- 🤖 **Telegram Bot** - Full-featured Telegram bot for Claude Code CLI
  - Group + Forum Topics support
  - Session management per topic
  - Interactive callbacks
  - Usage statistics
  - Daily reports

- 🔍 **Process Monitor** - Intelligent process monitoring daemon
  - Detects Claude process crashes
  - Distinguishes normal vs abnormal exits
  - Topic-aware notifications
  - 3-minute cooldown period

## Architecture

```
claude-bot/
├── telegram/          # Telegram Bot implementation
│   ├── bot/           # Bot handlers and commands
│   ├── claude/        # Claude CLI client
│   └── utils/         # Configuration and logging
├── monitor/           # Process monitoring daemon
│   ├── process-monitor.ts
│   └── types.ts
├── data/              # Session data persistence
├── logs/              # Application logs
└── docs/              # Documentation
```

## Prerequisites

- Node.js >= 18
- Claude Code CLI (`claude` command available)
- Telegram Bot Token

## Setup

```bash
# Install dependencies
npm install

# Create environment configuration
cp env.example .env

# Edit .env with your settings
# Required: TELEGRAM_BOT_TOKEN, AUTHORIZED_CHAT_ID
nano .env
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram Bot API token |
| `BOT_ACCESS_TOKEN` | Yes | - | Bot authentication token |
| `AUTHORIZED_CHAT_ID` | Yes | - | Authorized Telegram group chat ID |
| `DEFAULT_WORK_DIR` | No | `~/assistant` | Default working directory |
| `COMMAND_TIMEOUT` | No | `3600000` | Command execution timeout (ms) |
| `MAX_TURNS` | No | `500` | Maximum Claude execution turns |
| `MONITOR_CHECK_INTERVAL` | No | `5000` | Process check interval (ms) |
| `MONITOR_COOLDOWN` | No | `180000` | Notification cooldown period (ms) |
| `MONITOR_MIN_RUNTIME` | No | `2` | Min runtime for normal exit (seconds) |
| `MONITOR_MAX_RUNTIME` | No | `3600` | Max runtime threshold (seconds) |
| `http_proxy` | No | - | HTTP proxy URL |
| `https_proxy` | No | - | HTTPS proxy URL |

## Development

```bash
# Start Telegram Bot in development mode
npm run dev

# Start Process Monitor in development mode
npm run dev:monitor

# Or use the dev script (auto-restart on changes)
./dev.sh
```

## Production Deployment

```bash
# Deploy all services (systemd)
./deploy.sh deploy

# Check status
./deploy.sh status

# View logs
./deploy.sh logs

# Restart services
./deploy.sh restart

# Stop services
./deploy.sh stop
```

## Services

The project runs two systemd services:

### 1. claude-telegram
- Telegram Bot server
- Handles all user interactions
- Manages Claude CLI sessions

### 2. claude-monitor
- Process monitoring daemon
- Detects abnormal process exits
- Sends notifications to Telegram

## Telegram Bot Commands

### General Commands (in group)
- `/start` - Initialize bot
- `/login <token>` - Authenticate
- `/help` - Show help message
- `/status` - Show all sessions
- `/setcwd <path>` - Set default working directory
- `/usage [date]` - Show usage statistics
- `/model` - Switch global default model

### Topic Commands (in forum topics)
- `/cd <path>` - Change working directory for this topic
- `/clear` - Clear session history
- `/compact` - Manually compact context
- `/rewind` - Revert to previous session state
- `/plan` - Enter plan mode
- `/stop` - Stop running task
- `/info` - Show current session info
- `/model` - Switch model for this topic

## Process Monitor

The monitor daemon tracks all Claude CLI processes and sends notifications for:

- **Abnormal Exits**:
  - Runtime < 2 seconds (startup failure)
  - Non-zero exit code (crash)
  - OOM Killer or system signals
  - Runtime > 1 hour (timeout)

- **Normal Exits** (no notification):
  - Task completed successfully
  - Exit code 0
  - Runtime within normal range

See [monitor/README.md](monitor/README.md) for detailed documentation.

## Tech Stack

- **Runtime**: Node.js 18+ / TypeScript 5
- **Telegram**: Telegraf 4.16
- **Proxy**: https-proxy-agent, socks-proxy-agent
- **File Watching**: chokidar
- **Environment**: dotenv

## License

Private project
