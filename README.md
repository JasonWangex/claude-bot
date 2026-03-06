# Claude Bot

Discord Bot for Claude Code CLI integration — multi-session parallel development, goal orchestration, and local MCP server.

## Features

- **Discord Bot** — Full-featured Discord bot for Claude Code CLI
  - Category + Text Channel architecture, one channel per development session
  - Parallel sessions with isolated working directories and git worktrees
  - Interactive buttons, select menus, and modals (AskUserQuestion, ExitPlanMode)
  - Slash commands for session, task, and goal management
  - Claude hook integration (Stop / SessionEnd / Notification events)

- **Goal Orchestrator** — Autonomous multi-task scheduling engine
  - Breaks goals into subtasks with DAG dependency resolution
  - Dispatches tasks to isolated worktrees/channels in parallel
  - Auto-merges completed tasks back to goal branch
  - Tech Lead review, replan, rollback, and feedback loops

- **MCP Server** — Model Context Protocol server for Claude integration
  - 12 tools: channels, goals, tasks, devlogs, ideas, knowledge base, todos, events
  - Claude Code uses these tools natively as MCP tool calls

- **Web Dashboard** — React frontend for monitoring and control
  - Goals DAG visualization, session conversation viewer
  - Usage statistics, DevLog history, Knowledge Base, Ideas

- **REST API** — Local HTTP API for automation and skills
  - Channel/session management, goal drive control
  - Session sync, usage tracking, prompt configuration

- **Process Monitor** — Intelligent crash detection daemon
  - Detects abnormal Claude process exits
  - Discord notifications with 3-minute cooldown

## Architecture

```
claude-bot/
├── discord/           # Main application
│   ├── bot/           # Discord bot handlers, commands, state, message queue
│   ├── claude/        # Claude CLI executor (stream-json parsing)
│   ├── api/           # REST API server and routes
│   ├── orchestrator/  # Goal scheduling engine (drive, review, replan, rollback)
│   ├── sync/          # Session sync service (JSONL parsing, usage tracking)
│   ├── services/      # Channel service, prompt config service
│   ├── db/            # SQLite database layer and repositories
│   ├── utils/         # Config, git, logger, OSS, image processor
│   └── types/         # TypeScript type definitions
├── mcp/               # MCP server (stdio transport, 12 tools)
├── web/               # React web dashboard (Vite)
├── monitor/           # Process monitoring daemon
├── skills/            # Claude Code skill definitions
├── hooks/             # Claude CLI hook scripts (Stop, SessionEnd)
├── scripts/           # Automation scripts
├── data/              # SQLite database + process temp files (gitignored)
└── docs/              # Documentation
```

## Quick Start

**New to this project?** → See the [Quick Start Guide](docs/quickstart.md) for step-by-step setup including Discord bot creation and directory configuration.

## Prerequisites

- Node.js >= 18
- Claude Code CLI — download at **https://claude.ai/download**
- Discord Bot Token + Application ID

## Setup

```bash
# Interactive setup wizard (recommended)
./config.sh

# Or manual setup
npm install
cp example.env .env
# Edit .env with your settings
nano .env
```

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | Discord Application ID |
| `BOT_ACCESS_TOKEN` | API authentication token |

### Auto-filled (by /login command)
| Variable | Description |
|----------|-------------|
| `AUTHORIZED_GUILD_ID` | Authorized Guild ID |
| `GENERAL_CHANNEL_ID` | #general channel ID |

### Paths
| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_WORK_DIR` | `~/` | Default working directory |
| `PROJECTS_ROOT` | `~/projects` | Projects root directory |
| `WORKTREES_DIR` | `$PROJECTS_ROOT/worktrees` | Git worktree directory |

### Claude CLI
| Variable | Default | Description |
|----------|---------|-------------|
| `COMMAND_TIMEOUT` | `3600000` | Command execution timeout (ms) |
| `MAX_TURNS` | `500` | Maximum Claude execution turns |
| `STALL_TIMEOUT` | `60000` | No-output timeout (ms) |
| `PIPELINE_SONNET_MODEL` | `claude-sonnet-4-6` | Orchestrator Sonnet model |
| `PIPELINE_OPUS_MODEL` | `claude-opus-4-6` | Orchestrator Opus model |

### API
| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3456` | REST API port (0 to disable) |
| `API_LISTEN` | `127.0.0.1` | Listen address (`0.0.0.0` for Tailscale) |
| `WEB_URL` | - | Web dashboard URL (shown in Done messages) |

### Optional
| Variable | Description |
|----------|-------------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key (branch name generation) |
| `GOAL_LOG_CHANNEL_ID` | Dedicated channel for Goal pipeline logs |
| `DISCORD_NOTIFY_USER_ID` | User ID for @mention in notifications |
| `OSS_REGION` | Aliyun OSS region |
| `OSS_BUCKET` | Aliyun OSS bucket |
| `OSS_ACCESS_KEY_ID` | Aliyun OSS access key |
| `OSS_ACCESS_KEY_SECRET` | Aliyun OSS secret |

### Process Monitor
| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_CHECK_INTERVAL` | `5000` | Process check interval (ms) |
| `MONITOR_COOLDOWN` | `180000` | Notification cooldown (ms) |
| `MONITOR_SERVICES` | `claude-discord` | Services to monitor |

## Development

```bash
# Start Discord Bot in development mode
npm run dev

# Start Process Monitor in development mode
npm run dev:monitor

# Start Web Dashboard
cd web && npm run dev
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
```

## Services

Two systemd user services:

- **`claude-discord`** — Discord Bot + REST API server
- **`claude-monitor`** — Process crash detection daemon

## Slash Commands

### #general (any channel)
- `/login <token>` — Authenticate and bind bot to server
- `/start` — Show welcome message
- `/help` — Show command list
- `/status` — Show all active sessions

### Channel (development session)
**Session**:
- `/plan <msg>` — Send in plan mode
- `/clear` — Clear Claude context
- `/compact` — Compress Claude context
- `/rewind` — Undo last conversation turn
- `/stop [msg]` — Stop running task
- `/attach [id]` — Attach to existing Claude session
- `/sessions` — List Claude sessions for this channel

**Navigation**:
- `/cd [path]` — Change/show working directory
- `/info` — Show session details
- `/close [force]` — Close channel and cleanup worktree/branch
- `/model` — Switch model for this channel

**Development workflow**:
- `/qdev <desc>` — Quick-create dev branch + channel
- `/code-audit` — Run code audit on current branch diff
- `/commit [msg]` — Review and commit code
- `/merge <target>` — Merge branch and cleanup
- `/idea [content]` — Record/advance ideas
- `/goal [text]` — Manage development goals

## MCP Server

The MCP server exposes 12 tools for Claude Code integration:

| Tool | Description |
|------|-------------|
| `bot_channels` | List / get / delete channels |
| `bot_send_message` | Send message to a channel |
| `bot_qdev` | Quick-create dev sub-task |
| `bot_goals` | Goal CRUD (list/get/create/update) |
| `bot_goal_tasks` | Subtask management (list/set/skip/done/retry/reset/pause/nudge) |
| `bot_goal_todos` | Goal todo management |
| `bot_goal_event` | Trigger goal.drive event |
| `bot_devlogs` | DevLog list / create |
| `bot_ideas` | Ideas CRUD |
| `bot_kb` | Knowledge base CRUD |
| `bot_status` | Global bot status |
| `bot_task_event` | Write task event (agent → orchestrator) |

## Local Skills

6 skills installed to `~/.claude/skills/` via `scripts/install-skills.sh`:

| Skill | Description |
|-------|-------------|
| `/commit` | Code review + commit (Conventional Commits format) |
| `/merge` | Merge branch, cleanup worktree/channel, record DevLog |
| `/goal` | Goal management (list/search/create/drive via MCP) |
| `/devlog` | Record development log to SQLite |
| `/review` | Generate daily/weekly dev reports from SQLite |
| `/kb` | Knowledge base management (record lessons/insights) |

## Tech Stack

- **Runtime**: Node.js 18+ / TypeScript 5.9 (ESM, tsx)
- **Discord**: discord.js 14.x
- **Claude**: Claude Code CLI (stream-json)
- **Database**: SQLite (better-sqlite3, WAL mode)
- **MCP**: @modelcontextprotocol/sdk
- **Web**: React 18 + Vite + Ant Design
- **LLM**: DeepSeek API (lightweight tasks)
- **Storage**: Aliyun OSS (optional file uploads)

## License

Private project
