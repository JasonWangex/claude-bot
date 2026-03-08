# REST API Reference

Default: `127.0.0.1:3456`. Auth model: see `docs/architecture.md`.

## System
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/status | Global state (channels + sessions) |
| GET | /api/projects | Project list |
| POST | /api/projects/sync | Sync project directories |
| GET | /api/models | Available models |
| PUT | /api/models/default | Set global default model |

## Channels
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/channels | List all channels (tree) |
| POST | /api/channels | Create channel |
| GET | /api/channels/:id | Channel detail |
| PATCH | /api/channels/:id | Update (name/model/cwd) |
| DELETE | /api/channels/:id | Archive channel |
| POST | /api/channels/:id/fork | Fork channel (create worktree) |
| POST | /api/channels/:id/qdev | Quick dev subtask |
| POST | /api/channels/:id/code-audit | Start code audit |
| POST | /api/channels/:id/message | Send message (triggers Claude) |
| POST | /api/channels/:id/clear | Clear Claude context |
| POST | /api/channels/:id/compact | Compact Claude context |
| POST | /api/channels/:id/rewind | Undo last turn |
| POST | /api/channels/:id/stop | Stop current task |
| GET | /api/channels/:id/sessions | Channel session list |
| GET | /api/channels/:id/changes | Session file change records |

## Sessions & Usage
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/sessions | List all sessions |
| GET | /api/sessions/:id/meta | Session metadata |
| GET | /api/sessions/:id/conversation | Session conversation |
| GET | /api/sessions/usage/daily | Daily token/cost stats |
| GET | /api/sessions/usage/by-model | Usage grouped by model |

## Goals
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/goals | List goals (?status=&project=) |
| POST | /api/goals | Create goal |
| GET | /api/goals/:id | Goal detail |
| PATCH | /api/goals/:id | Update goal metadata |
| GET | /api/goals/:id/timeline | Goal timeline |
| POST | /api/goals/:id/tasks | Bulk set subtasks |
| POST | /api/goals/:id/drive | Start Drive |
| GET | /api/goals/:id/status | Drive status |
| POST | /api/goals/:id/pause | Pause Drive |
| POST | /api/goals/:id/resume | Resume Drive |
| POST | /api/goals/:id/tasks/:taskId/skip | Skip subtask |
| POST | /api/goals/:id/tasks/:taskId/done | Mark subtask done |
| POST | /api/goals/:id/tasks/:taskId/retry | Retry failed subtask |
| POST | /api/goals/:id/tasks/:taskId/reset | Full reset + restart |
| POST | /api/goals/:id/tasks/:taskId/pause | Pause subtask |
| POST | /api/goals/:id/tasks/:taskId/nudge | Nudge subtask to continue |
| GET | /api/goals/:id/todos | List todos |
| POST | /api/goals/:id/todos | Create todo |
| PATCH | /api/goals/:id/todos/:todoId | Update todo |
| DELETE | /api/goals/:id/todos/:todoId | Delete todo |

## Task Events (AI → Orchestrator IPC)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/events | List unprocessed events |
| POST | /api/tasks/:taskId/events | Write task event |
| POST | /api/goals/:id/events | Write goal event |

## Content (DevLogs, Ideas, KB)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | /api/devlogs | List / create devlog |
| GET | /api/devlogs/:id | Devlog detail |
| GET/POST | /api/ideas | List / create idea |
| GET/PATCH/DELETE | /api/ideas/:id | Idea CRUD |
| GET/POST | /api/kb | List / create KB entry |
| GET/PATCH/DELETE | /api/kb/:id | KB entry CRUD |

## Prompts
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/prompts | List prompt configs |
| POST | /api/prompts/refresh | Refresh from seed |
| GET/PATCH | /api/prompts/:key | Get / update prompt |

## Sync & Debug
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/sync/sessions | Sync Claude session files |
| POST | /api/sync/usage | Reconcile token/cost |
| POST | /api/sync/discord | Sync Discord channel state |
| GET | /api/debug/running-tasks | Running tasks (zombie detection) |
| GET | /api/debug/active-processes | Active Claude processes |
| POST | /api/debug/kill-zombie-tasks | Clean zombie tasks |

## Internal (localhost only)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/internal/hooks/session-event | Receive Claude CLI hook events |
