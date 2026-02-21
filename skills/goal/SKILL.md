---
name: goal
description: >
  Manage large development goals with subtask decomposition, progress tracking,
  and parallel Drive execution. Triggers when user mentions goal management,
  task breakdown, Goal, Drive, "check current goals", or "continue previous task".
---

# Goal - Development Goal Management

Adds **persistence** (SQLite) and **parallel execution** (Drive API) on top of plan mode's research → plan → review workflow.

State flow: `Pending → Collecting → Planned → Processing → Completed → Merged`. Processing can enter `Blocking`.

## Mode dispatch

Based on `$ARGUMENTS`:

| Input | Mode |
|-------|------|
| Empty | List: query Goals by status + recent 5 Ideas, display grouped by status |
| `drive all` | Batch drive: query Planned + Blocking Goals, start Drive for each, output summary |
| Other | `bot_goals(action="list", q=input)` → 1 match → continue; multiple → list for selection; none → create |

---

## Create mode

### 1. Create record

```
bot_goals(action="create", name="<<=10 chars>", project="<project name>", status="Collecting", type="探索型|交付型", completion="<completion criteria>")
```

Project name: path contains `claude-bot` → claude-bot; contains `LearnFlashy` → LearnFlashy; otherwise → directory name.

### 2. Planning (reuse plan mode workflow)

Collaborate with user following plan mode's natural rhythm:

**Research** — Understand requirements, clarify questions, explore codebase
**Plan** — Decompose into subtasks by feature (rules in `references/planning-guide.md`), write into body (template in `references/body-template.md`)
**Review** — Show plan summary, enter confirmation loop: user modifies → update → re-display; user confirms (start/ok/lgtm) → next step

Difference from standard plan mode: plan is written to Goal body (`bot_goals(action="update")`) instead of local markdown files, enabling cross-session persistence.

### 3. Launch

`bot_goals(action="update", goal_id=..., status="Planned")` → Drive launch (see below)

---

## Continue mode

`bot_goals(action="get", goal_id=...)` to get details, then route by status:

| Status | Behavior |
|--------|----------|
| Collecting | Continue plan mode planning workflow |
| Planned (all tasks pending or empty) | Show plan, launch Drive after confirmation |
| Planned/Processing/Blocking (has non-pending tasks) | Has incomplete tasks → launch Drive |
| Completed | Show summary, prompt merge |
| Merged | Show archive |

**User commands** (must `bot_goals(action="get")` for latest version before modifying body):

- Complete/add subtasks → update body + progress/next
- Record decisions → append to decision log (with date)
- Direction change → archive abandoned tasks + record decision
- Status change → `bot_goals(action="update", goal_id=..., status=...)`

---

## Drive launch

All places that need to start Drive use this unified flow:

1. Build tasks: prefer `tasks` from API response; if empty, parse `[代码]`/`[调研]` types from body, filter completed. IDs must use `g<seq>t<N>` format (seq = Goal's `seq` field from API), preventing cross-goal ID collisions.
   ```json
   [{"id":"g2t1","description":"description","type":"代码|调研|手动|占位","complexity":"simple|complex","phase":1,"status":"pending"}]
   ```
   Tasks are ordered by phase: phase 1 runs first (all parallel), then phase 2, etc.
2. Get current thread ID: `bot_tasks(action="list")` → match task's `cwd` field with current cwd → get `channel_id`
3. Call:
   ```
   bot_goals(action="drive", goal_id="<goal-id>", goal_name="<n>", goal_channel_id="<channel_id>", base_cwd="<cwd>", tasks="<JSON array string>", max_concurrent=3)
   ```
4. Success → `bot_goals(action="update", goal_id=..., status="Processing")`; Failure → output error, keep current status, prompt retry
