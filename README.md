# Claude Bot

Discord Bot for Claude Code CLI integration with process monitoring.

## Features

- **Discord Bot** - Full-featured Discord bot for Claude Code CLI
  - Guild + Forum Channel + Forum Post architecture
  - Session management per thread
  - Interactive buttons, select menus, and modals
  - Slash commands
  - Goal orchestration and auto-scheduling

- **Process Monitor** - Intelligent process monitoring daemon
  - Detects Claude process crashes
  - Distinguishes normal vs abnormal exits
  - Thread-aware notifications
  - 3-minute cooldown period

- **REST API** - Local HTTP API for automation
  - Task CRUD operations
  - Session management
  - Goal drive control

## Architecture

```
claude-bot/
├── discord/           # Discord Bot implementation
│   ├── bot/           # Bot handlers, commands, state
│   ├── claude/        # Claude CLI client
│   ├── api/           # REST API server and routes
│   ├── db/            # SQLite database layer and repositories
│   ├── orchestrator/  # Goal auto-scheduling engine
│   ├── utils/         # Configuration, git, logging
│   └── types/         # TypeScript type definitions
├── monitor/           # Process monitoring daemon
├── skills/            # Claude Code skill definitions
├── data/              # SQLite database + process temp files
└── docs/              # Documentation
```

## Prerequisites

- Node.js >= 18
- Claude Code CLI (`claude` command available)
- Discord Bot Token + Application ID

## Setup

```bash
# Install dependencies
npm install

# Create environment configuration
cp example.env .env

# Edit .env with your settings
# Required: DISCORD_TOKEN, DISCORD_APPLICATION_ID, BOT_ACCESS_TOKEN
nano .env
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | - | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | Yes | - | Discord Application ID |
| `BOT_ACCESS_TOKEN` | Yes | - | Bot authentication token |
| `AUTHORIZED_GUILD_ID` | Auto | - | Authorized Guild ID (set via /login) |
| `GENERAL_CHANNEL_ID` | Auto | - | #general channel ID (set via /login) |
| `DEFAULT_WORK_DIR` | No | `~/` | Default working directory |
| `PROJECTS_ROOT` | No | `~/projects` | Projects root directory |
| `WORKTREES_DIR` | No | `$PROJECTS_ROOT/worktrees` | Worktree directory |
| `COMMAND_TIMEOUT` | No | `3600000` | Command execution timeout (ms) |
| `MAX_TURNS` | No | `500` | Maximum Claude execution turns |
| `API_PORT` | No | `3456` | REST API port (0 to disable) |
| `MONITOR_CHECK_INTERVAL` | No | `5000` | Process check interval (ms) |
| `MONITOR_COOLDOWN` | No | `180000` | Notification cooldown period (ms) |
| `MONITOR_SERVICES` | No | `claude-discord` | Services to monitor |

## Development

```bash
# Start Discord Bot in development mode
npm run dev

# Start Process Monitor in development mode
npm run dev:monitor
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

### 1. claude-discord
- Discord Bot server
- Handles all user interactions via slash commands
- Manages Claude CLI sessions per Forum Post thread

### 2. claude-monitor
- Process monitoring daemon
- Detects abnormal process exits
- Sends notifications to Discord #general

## Slash Commands

### #general (Text Channel)
- `/login <token>` - Authenticate and bind bot to server
- `/start` - Initialize bot
- `/help` - Show help message
- `/status` - Show all active tasks
- `/model` - Switch global default model

### Forum Post (Thread)
- `/plan <msg>` - Send in plan mode
- `/cd <path>` - Change working directory
- `/clear` - Clear Claude context
- `/compact` - Compress Claude context
- `/rewind` - Undo last conversation turn
- `/stop` - Stop running task
- `/info` - Show session details
- `/close` - Close thread and cleanup
- `/qdev <desc>` - Quick dev branch creation
- `/idea <desc>` - Record/advance ideas
- `/commit` - Review and commit code
- `/merge <target>` - Merge branch and cleanup
- `/model` - Switch model for this thread
- `/attach <id>` - Attach to Claude session

## Tech Stack

- **Runtime**: Node.js 18+ / TypeScript 5.9
- **Discord**: discord.js 14.x
- **Claude**: Claude Code CLI (stream-json)
- **Database**: SQLite (better-sqlite3, WAL mode)
- **Monitoring**: Discord REST API (independent daemon)

## License

Private project
