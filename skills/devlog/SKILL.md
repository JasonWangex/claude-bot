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

If the context already contains `DEVLOG_` prefixed info (from merge script output), use directly to create **one** devlog entry:
- `DEVLOG_COMMIT_COUNT` → number of commits
- `DEVLOG_COMMIT_MESSAGES` → commit message list
- `DEVLOG_DIFF_STAT` → diff statistics

Also read the full diff to extract any "why" info from commit message bodies.

Skip bookmark check in this scenario (merge already defines the range). Still update bookmark after successful write.

### Scenario B: Standalone invocation

Use `devlog/last` tag as bookmark, collect new commits since last recording.

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Determine starting point
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
```

**If COMMIT_COUNT is 0**: Inform user "no new commits to record" and stop.

**If DEVLOG_NO_BOOKMARK=true** (first use): Show collected commit list, confirm range before writing.

#### Grouping commits into devlog entries

After getting the commit range, group commits into **separate devlog entries** using a two-pass strategy:

```bash
# List all merge commits in range (oldest first)
git log ${BASE}..HEAD --merges --pretty=format:"%H %s" --reverse

# List all commits in range with full message body (oldest first)
git log ${BASE}..HEAD --pretty=format:"%H|||%s|||%b|||%ai" --reverse
```

**Pass 1 — Split by merge commits:**
1. Each merge commit (`Merge branch '...'`) = one group boundary.
2. If no merge commits: entire range is one group.
3. Each group spans from the previous boundary (exclusive) to the current merge commit (inclusive).

**Pass 2 — Split large groups by threshold (>= 8 commits):**

If any group has >= 8 commits, further split it by finding natural breakpoints:

- **Type boundary**: consecutive commits switch between major types (feat→fix, fix→chore, etc. based on subject prefix or content)
- **File-area boundary**: commits touching completely different subsystems (e.g. `discord/api/` vs `discord/claude/` vs `skills/`)
- **Time gap**: commits more than 4 hours apart suggest separate work sessions

Splitting algorithm:
1. Walk commits in the group oldest-first
2. When a breakpoint is detected, close the current sub-group and start a new one
3. A sub-group must have at least 2 commits; if splitting would create a 1-commit remainder, merge it into the adjacent group
4. Maximum split depth: 1 level (don't recursively split sub-groups)

**Result**: Write **one devlog per final group**, not one devlog for the entire range.

### Extracting "Why" information

The "Background & Motivation" section must only be written with **real, verifiable information**. Sources (in priority order):

1. **Commit message body** (lines after the subject line) — most reliable
2. **Branch name** — e.g. `fix/duplicate-result-message` hints at the problem being fixed
3. **Diff context** — what the code change actually fixes/adds (describe what, not fabricate why)

**If no "why" info is available**: omit the "Background & Motivation" section entirely. Do not invent reasons.

### Additional data collection per group

```bash
git diff --stat <prev>..<current>
git diff --name-status <prev>..<current>
git log <prev>..<current> --pretty=format:"%h %s (%ai)"
git log <prev>..<current> --pretty=format:"%h%n%B"  # includes commit body
```

### Project name detection

Determine project from current working directory:
- Path contains `claude-bot` → `claude-bot`
- Path contains `LearnFlashy` → `LearnFlashy`
- Otherwise → use directory name

### Goal association

If the current context clearly indicates an associated Goal, fill in the Goal name; otherwise leave empty.

```
bot_goals(action="list", status="Processing")
```

## Write to SQLite

For **each group**, write one devlog:

```
bot_devlogs(action="create",
  name="<feature title, Chinese, <=10 chars>",
  date="<commit date of last commit in group, yyyy-MM-dd>",
  project="<project name>",
  branch="<branch name merged, or current branch>",
  summary="<1-2 sentence natural language summary>",
  commits=<commit count in this group>,
  lines_changed="<diff stat for this group>",
  goal="<associated active Goal name, optional>",
  content="<Markdown formatted detailed content>"
)
```

### Content format

```markdown
## 背景与动机
(仅在有真实信息时才写，来源：commit body、branch 名、代码变更本身。禁止编造。)

## 关键变更
- **变更标题**: 具体描述

## Commits
<hash> <message> (<date>)

## 文件变更
| 文件 | 变更 | 说明 |
|------|------|------|
| path/to/file | +20 -5 | 该文件改动的目的 |
```

**Content generation requirements:**
1. Write in Chinese
2. "背景与动机" — only include if there's real "why" info; omit entirely if not available
3. "关键变更" — describe what changed and why it matters (based on actual diff)
4. "文件变更" table — brief purpose description per file

## Update bookmark

**After all groups are written**, update the bookmark once:

```bash
git tag -f devlog/last HEAD
```

Output confirmation: how many devlog entries were created.
