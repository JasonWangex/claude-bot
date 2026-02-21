# Subtask Planning Guide

## Decomposition principles

Split by **feature**, not by technical layer. One feature = one subtask, even if it spans frontend and backend. Only split into separate subtasks when there is no code coupling and each can be delivered independently.

## Types

| Annotation | Drive handling |
|-----------|---------------|
| `[代码, simple]` | Auto-execute (default complexity) |
| `[代码, complex]` | Auto-execute (requires architecture design / cross-module coordination) |
| `[调研]` | Auto-execute |
| `[手动]` | Not sent to Drive, user completes manually |

## Phase ordering

Tasks are grouped into phases. **All tasks in phase N must complete before phase N+1 begins.** Tasks within the same phase run in parallel.

- Use `Phase 1`, `Phase 2`, `Phase 3` to group tasks by execution order
- Tasks that can run concurrently go in the same phase
- A phase must be complete (all tasks merged or skipped) before the next phase starts
- If a task has no phase specified, it defaults to Phase 1

## Each subtask must include

- **Goal**: What to do (one sentence)
- **Why**: Design intent
- **Implementation**: File list, data structures, core logic
- **Caveats** (optional): Edge cases, compatibility, risks
