# Subtask Planning Guide

## Decomposition principles

Split by **feature**, not by technical layer. One feature = one subtask, even if it spans frontend and backend. Only split into separate subtasks when there is no code coupling and each can be delivered independently.

## Types

| Annotation | Drive handling |
|-----------|---------------|
| `[代码, simple]` | Auto-execute (default complexity) |
| `[代码, complex]` | Auto-execute (requires architecture design / cross-module coordination) |
| `[调研]` | Auto-execute (Opus model) |
| `[测试]` | Auto-execute (dedicated test review) |
| `[占位]` | Not dispatched; auto-triggers replan when phase deps are met |
| `[手动]` | Not sent to Drive, user completes manually |

## Phase ordering

Tasks run in phase order. **All tasks in phase N must complete before phase N+1 begins.** Tasks within the same phase run in parallel.

- Annotate each task with `p:N` in its type bracket: `[代码, simple, p:1]`, `[调研, p:2]`
- Phase is stored per-task in the database (`tasks.phase` column) -- set via `bot_goal_tasks(action="set")` during Drive launch
- Tasks that can run concurrently share the same phase number
- If no `p:N` specified, phase defaults to 1
- `[测试]` tasks must be placed in the phase immediately after the implementation tasks they verify (e.g. if implementation is `p:1`, its tests must be `p:2`)

## Each subtask must include

- **目标**: What to do (one sentence)
- **为什么**: Design intent
- **实现**: File list, data structures, core logic
- **注意事项** (optional): Edge cases, compatibility, risks
