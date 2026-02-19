---
name: review
description: >
  Auto-generate daily/weekly dev reports. Collects data from SQLite database
  (via MCP tools) and Git, generates structured reviews, outputs to current
  conversation. Supports daily (default) and weekly modes.
---

# Review - Dev Report

Auto-collect DevLog and Goals data to generate structured daily or weekly reports.

## Mode selection

- `$ARGUMENTS` is empty or contains "today"/"daily" → **Daily mode** (default)
- `$ARGUMENTS` contains "week"/"weekly" → **Weekly mode**
- `$ARGUMENTS` contains a date (e.g. "2026-02-10") → Query that specific date

## Step 1: Collect data

### 1.1 From DevLog

```
# Daily: query today's DevLog
bot_devlogs(action="list", date="<today yyyy-MM-dd>")

# Weekly: query this week's DevLog
bot_devlogs(action="list", start="<this Monday yyyy-MM-dd>", end="<today yyyy-MM-dd>")
```

For each DevLog entry, extract: name, project, branch, summary, commits, lines_changed, goal, content

### 1.2 From Goals

```
bot_goals(action="list", status="Processing")
```

For each Processing Goal, extract: name, progress, next, blocked_by

### 1.3 From Git (supplementary)

Run git commands to capture direct commits not going through merge:

```bash
# Daily
git log --since="today 00:00" --pretty=format:"- %h %s (%ar)" --all

# Weekly
git log --since="last monday" --pretty=format:"- %h %s (%ar)" --all
```

## Step 2: Generate report

### Daily format

```
Daily Report — <date>

## Completed Today
(Generated from DevLog entries, grouped by project)

### <Project Name>
- **<Feature Title>**: <Summary>
  Branch: <branch> | <commits> commits | <lines changed>

## Goal Progress
- <Goal Name>: <Progress> — Next: <Next>
- <Goal Name>: <Progress> — Blocked by: <BlockedBy>

## Git Activity
(Supplementary commits not in DevLog)

## Insights & Lessons
(Extract notable patterns, pitfalls, architecture decisions from today's DevLog content)
```

### Weekly format

```
Weekly Report — <start date> ~ <end date>

## Week Overview
(2-3 sentences summarizing overall direction)

## Completed Items
(DevLog entries grouped by project)
Stats: <N> merges, <total commits> commits

## Goal Progress
- <Goal Name>: <progress changes this week> — Next: <Next>

## Lessons Learned
(Consolidated patterns and insights from the week)

## Next Week Direction
(Inferred from Goals' Next and BlockedBy)
```

## Output

Output the report directly in the current conversation. Do not write to database.
