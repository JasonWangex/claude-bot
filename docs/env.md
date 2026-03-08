# Environment Variables

Copy `example.env` to `.env`. Run `./config.sh` for interactive setup.

## Required
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | Discord Application ID |
| `BOT_ACCESS_TOKEN` | API auth token (required for Tailscale requests) |

## Auto-populated (after /login)
| Variable | Description |
|----------|-------------|
| `AUTHORIZED_GUILD_ID` | Authorized Guild ID |
| `GENERAL_CHANNEL_ID` | #general channel ID |

## Directories
| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_WORK_DIR` | `~/` | Default working directory |
| `PROJECTS_ROOT` | `~/projects` | Projects root |
| `WORKTREES_DIR` | `$PROJECTS_ROOT/worktrees` | Git worktree root |

## Claude CLI
| Variable | Default | Description |
|----------|---------|-------------|
| `COMMAND_TIMEOUT` | `3600000` | Command timeout ms (1h) |
| `MAX_TURNS` | `500` | Max Claude turns |
| `STALL_TIMEOUT` | `60000` | No-output stall timeout ms |
| `PIPELINE_SONNET_MODEL` | `claude-sonnet-4-6` | Orchestrator review model |
| `PIPELINE_OPUS_MODEL` | `claude-opus-4-6` | Orchestrator Opus model |

## API
| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3456` | HTTP API port (0 = disabled) |
| `API_LISTEN` | `127.0.0.1` | Listen address (`0.0.0.0` for Tailscale) |
| `WEB_URL` | — | Web dashboard URL (appended to Done messages) |

## Notifications
| Variable | Description |
|----------|-------------|
| `GOAL_LOG_CHANNEL_ID` | Goal pipeline log channel |
| `DISCORD_NOTIFY_USER_ID` | User ID to @mention |

## Optional Integrations
| Variable | Description |
|----------|-------------|
| `DEEPSEEK_API_KEY` | DeepSeek API key (branch name / title generation) |
| `OSS_REGION` | Aliyun OSS region (e.g. `oss-cn-hangzhou`) |
| `OSS_BUCKET` | OSS bucket name |
| `OSS_ACCESS_KEY_ID` | OSS access key ID |
| `OSS_ACCESS_KEY_SECRET` | OSS access key secret |

## Process Monitor
| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_CHECK_INTERVAL` | `5000` | Check interval ms |
| `MONITOR_COOLDOWN` | `180000` | Notification cooldown ms |
| `MONITOR_SERVICES` | `claude-discord` | Services to monitor |
