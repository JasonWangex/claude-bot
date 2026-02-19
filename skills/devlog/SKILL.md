---
name: devlog
description: >
  Record dev logs to SQLite database (via MCP tools). Can be invoked standalone
  or called by other skills like /merge. Auto-collects git info, generates summaries,
  and writes to database. Uses git tags to track progress and avoid duplicates.
---

# Dev Log

Record development progress to local SQLite database (via MCP tools).

## Data Collection

Depending on the invocation context:

### Scenario A: Called from /merge (info already available)

If the context already contains `DEVLOG_` prefixed info (from merge script output), use directly:
- `DEVLOG_COMMIT_COUNT` → number of commits
- `DEVLOG_COMMIT_MESSAGES` → commit message list
- `DEVLOG_DIFF_STAT` → diff statistics

Skip bookmark check in this scenario (merge already defines the range). Still update bookmark after successful write.

### Scenario B: Standalone invocation

Use `devlog/last` tag as bookmark, only collect new commits since last recording.

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Determine starting point: use bookmark if exists, otherwise last 20 commits
if git rev-parse devlog/last >/dev/null 2>&1; then
  BASE="devlog/last"
else
  echo "DEVLOG_NO_BOOKMARK=true"
  BASE="HEAD~20"  # First use, look back 20 commits as candidates
fi

if [ "$BRANCH" != "main" ]; then
  BASE="main"
fi

COMMIT_COUNT=$(git log ${BASE}..HEAD --oneline | wc -l | tr -d ' ')
COMMIT_MESSAGES=$(git log ${BASE}..HEAD --pretty=format:"- %s")
DIFF_STAT=$(git diff --shortstat ${BASE}..HEAD)
```

**If COMMIT_COUNT is 0**: Inform user "no new commits to record" and skip writing.

**If DEVLOG_NO_BOOKMARK=true** (first use): Show collected commit list to user, confirm the range is correct before writing.

### Additional data collection

```bash
git diff --stat ${BASE}..HEAD
git diff --name-status ${BASE}..HEAD
git log ${BASE}..HEAD --pretty=format:"%h %s (%ai)"
```

### Project name detection

Determine project from current working directory:
- Path contains `claude-bot` → `claude-bot`
- Path contains `LearnFlashy` → `LearnFlashy`
- Otherwise → use directory name

### Goal association

If the current context clearly indicates an associated Goal (e.g. branch name contains goal keywords), fill in the Goal name; otherwise leave empty.

To query active Goals:

```
bot_goals(action="list", status="Processing")
```

## Write to SQLite

Write DevLog via MCP tool:

```
bot_devlogs(action="create",
  name="<feature title, Chinese, <=10 chars>",
  date="<today yyyy-MM-dd>",
  project="<project name>",
  branch="<branch name>",
  summary="<1-2 sentence natural language summary>",
  commits=<commit count>,
  lines_changed="<diff stat raw text>",
  goal="<associated active Goal name, optional>",
  content="<Markdown formatted detailed content>"
)
```

### Content format

Generate detailed content in Markdown:

```markdown
## Background & Motivation
(2-3 sentences explaining why this change was made, showing engineering reasoning.)

## Key Changes
- **Change 1 title**: specific description
- **Change 2 title**: specific description

## Commits
<hash> <message> (<date>)

## File Changes
| File | Changes | Description |
|------|---------|-------------|
| path/to/file | +20 -5 | Brief description of what changed |
```

**Content generation requirements:**
1. Write in Chinese
2. "Background & Motivation" should explain "why" not "what"
3. "Key Changes" should consolidate and group related commits
4. "File Changes" table description column should briefly explain the purpose

## Update bookmark

**After successful write**, update the git tag bookmark:

```bash
git tag -f devlog/last HEAD
```

Output confirmation after successful write.
