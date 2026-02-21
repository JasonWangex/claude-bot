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

Drive is **skill-driven** — Claude reviews, confirms with user, initializes tasks in DB, then signals the Orchestrator via event.

### Step 1 — Review & discuss
Read the goal body. Summarize the task list by phase (e.g. "Phase 1: 3 tasks in parallel, Phase 2: 2 tasks sequentially"). Ask the user if anything needs adjusting before proceeding. **Wait for explicit confirmation** (ok / lgtm / yes).

### Step 2 — Pre-flight checks (after user confirms)
From `bot_goals(action="get")` verify:
- `drive_status` is `null` → new launch; `paused` → will auto-resume; `running` → report and stop
- Each pending task has a valid `id` in `g<seq>t<N>` format, a `type`, and a `p:N` phase annotation — if any task is missing `p:N`, infer phase from dependencies and update the body (`bot_goals(action="update", body=...)`) before proceeding

### Step 3 — Initialize tasks in DB
Write the complete pending task list (with phase) to the database:
```
bot_goal_tasks(action="set", goal_id="<id>", tasks='[
  {"id":"g2t1","description":"...","type":"代码","complexity":"simple","phase":1},
  {"id":"g2t2","description":"...","type":"调研","phase":1},
  {"id":"g2t3","description":"...","type":"代码","complexity":"complex","phase":2}
]')
```
Only include tasks that are **not yet completed** (unchecked `- [ ]` in body).

### Step 4 — Get thread ID
`bot_tasks(action="list")` → match task's `cwd` with current cwd → get `channel_id`

### Step 5 — Send drive event
```
bot_goal_event(goal_id="<id>", event_type="goal.drive", payload={
  "goalName": "<name>",
  "goalChannelId": "<channel_id>",
  "baseCwd": "<cwd>",
  "maxConcurrent": 3
})
```
Orchestrator picks up the event within 5 seconds and starts Drive automatically.

### Step 6 — Update status
`bot_goals(action="update", goal_id=..., status="Processing")`
