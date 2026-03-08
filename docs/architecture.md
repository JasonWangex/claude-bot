# Architecture

## Subsystems

**Discord Bot** (`discord/bot/`)
- `discord.ts` — `DiscordBot` class, lifecycle and event wiring
- `handlers.ts` — Routes text messages to Claude executor, parses streaming output
- `message-queue.ts` — Producer-consumer queue, 45 op/s token bucket, per-channel serial delivery; messages >2000 chars → Embed, >4096 → file attachment
- `commands/` — Slash command handlers (goal, session, dev, model, task)
- `interaction-registry.ts` — Button/SelectMenu/Modal callbacks (`AskUserQuestion`, `ExitPlanMode`, Drive controls)

**Claude Executor** (`discord/claude/`)
- `executor.ts` — Spawns `claude` CLI process, parses `stream-json` output, injects stdin, detects stalls
- `client.ts` — Facade: `run / compact / stop / rewind`

**Goal Orchestrator** (`discord/orchestrator/`)
- `drive.ts` — Goal lifecycle: start / pause / resume
- `task-scheduler.ts` — DAG topological sort, phase grouping, concurrency control (default max 3)
- `dispatch.ts` — Creates git worktree + Discord channel, sends task prompt to Claude
- `event-scanner.ts` — Polls `task_events` table every 2 s, drives the pipeline
- `review-handler.ts` — Tech Lead audit (Sonnet model): verdict `pass` → merge, `fail` → retry, `replan` → replanner
- `merge-handler.ts` — Merges task branch to goal branch, cleans up worktree + channel
- `goal-audit-handler.ts` — Full code-audit after all tasks complete

**REST API** (`discord/api/`, port 3456)
Auth: localhost (127.0.0.1/::1) skips token; Tailscale (100.64.0.0/10) requires `Authorization: Bearer <BOT_ACCESS_TOKEN>`; other IPs rejected.
See `docs/api.md` for all routes.

**MCP Server** (`mcp/`)
Stdio transport; 12 tools that proxy to the Bot REST API. Entry: `mcp/server.ts`.

**Database** (`discord/db/`, SQLite WAL at `data/bot.db`)
Migrations via `pragma user_version` (sequential files in `discord/db/migrations/`).

**Session Sync** (`discord/sync/`)
Scans `~/.claude/projects/` JSONL files → syncs token usage/cost to `claude_sessions` table. `session-timeout-service` auto-closes stalled sessions.

## Goal Drive Flow

```
User /goal → Create goal → set tasks → Drive start
  → event-scanner polls task_events (2 s)
  → dispatch ready tasks (phase-by-phase, blocked_by resolved)
    → each task: create worktree + Discord channel → send prompt to Claude
  → Claude completes → writes task.completed event
  → review-handler audits diff (Sonnet)
      pass    → merge-handler merges to goal branch → next phase
      fail    → retry task
      replan  → replanner generates new task plan
  → all tasks done → goal-level code-audit → Goal complete
```

## Database Tables

| Table | Description |
|-------|-------------|
| `channels` | Discord channel config and state |
| `claude_sessions` | Claude CLI sessions (synced from JSONL) |
| `channel_session_links` | Channel ↔ Session association |
| `guilds` | Guild config |
| `goals` | Development goals |
| `tasks` | Goal subtasks (dependency, phase, status) |
| `task_events` | AI → Orchestrator IPC events |
| `goal_events` | Goal-level events |
| `goal_timeline` | Goal audit log |
| `goal_todos` | Per-goal todo items |
| `checkpoints` | Rollback checkpoints |
| `devlogs` | Development logs |
| `ideas` | Idea records |
| `knowledge_base` | KB entries |
| `projects` | Project directory records |
| `prompt_config` | Configurable AI prompt templates |
| `session_changes` | Session file change records |
| `sync_cursors` | Sync cursors for incremental scans |
