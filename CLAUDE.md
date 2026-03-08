# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Discord-native development orchestrator: each Discord text channel = one Claude Code CLI session. Goals decompose into DAG tasks dispatched as isolated git worktrees with their own channels.

## Hard Rules

- **TypeScript enums** — All fixed string sets (status, type, phase, priority) must be `string enum`. Never use string literal unions or magic strings. Enums are values; re-export with `export { MyEnum }`, never `export type { MyEnum }`. Definitions live in `discord/types/index.ts` and `discord/types/db.ts`.
- **MessageQueue** — Never call `channel.send()` directly. All Discord sends go through `MessageQueue` (`discord/bot/message-queue.ts`).
- **Repo pattern** — DB access only through repository classes. Raw SQL stays inside repos. All repos exported from `discord/db/index.ts`.
- **Orchestrator IPC** — `task_events` table is the sole IPC channel between Claude (writer) and the Orchestrator (reader via `event-scanner.ts`). Do not bypass with direct state mutation.
- **Config** — All env vars parsed once in `discord/utils/config.ts` → `DiscordBotConfig`. Never read `process.env` elsewhere.

## Testing

```bash
npm run test        # vitest run
npm run test:watch  # vitest watch
```

## Reference Docs

- `docs/architecture.md` — Subsystems, Goal Drive flow, DB schema
- `docs/api.md` — REST API routes (port 3456)
- `docs/env.md` — Environment variables
