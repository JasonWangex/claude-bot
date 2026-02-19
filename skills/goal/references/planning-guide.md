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

Dependencies: `— depends: g2t1, g2t2` (IDs include goal seq prefix to prevent cross-goal ID collisions). Optional Phase grouping.

## Each subtask must include

- **Goal**: What to do (one sentence)
- **Why**: Design intent
- **Implementation**: File list, data structures, core logic
- **Caveats** (optional): Edge cases, compatibility, risks
