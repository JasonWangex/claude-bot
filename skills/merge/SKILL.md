---
name: merge
description: >
  Merge worktree branch to main and cleanup. Checks for uncommitted code,
  merges branch, removes worktree, deletes Discord thread.
  Auto-records Dev Log after successful merge.
disable-model-invocation: true
---

# Merge & Cleanup

Merge a worktree branch into main and clean up resources.

**Target branch:** $ARGUMENTS

**Current worktree info:**
!`git worktree list`

## Step 1: Parse arguments

Extract from the worktree list above:
- **TARGET_BRANCH**: branch name specified by `$ARGUMENTS`
- **TARGET_CWD**: worktree path for TARGET_BRANCH
- **MAIN_CWD**: worktree path marked with `[main]` or `[master]`

If no worktree found for TARGET_BRANCH, report error and stop.

## Step 2: Merge and cleanup

**Important: Execute all operations in a single bash script. Do not split into separate commands.**

Fill parsed parameters into this script:

```bash
#!/bin/bash
set -e

TARGET_CWD="<parsed TARGET_CWD>"
TARGET_BRANCH="<parsed TARGET_BRANCH>"
MAIN_CWD="<parsed MAIN_CWD>"

echo "=== Step 1: Check working directory ==="
cd "$TARGET_CWD"
STATUS=$(git status --porcelain)
if [ -n "$STATUS" ]; then
  echo "Found uncommitted changes, auto-committing..."
  git add -A && git commit -m "auto commit before merge" || { echo "FAIL: auto commit failed"; exit 1; }
fi
echo "Working directory clean"

echo "=== Step 2: Collect branch info (pre-merge) ==="
cd "$MAIN_CWD"
COMMIT_COUNT=$(git log main.."$TARGET_BRANCH" --oneline | wc -l | tr -d ' ')
COMMIT_MESSAGES=$(git log main.."$TARGET_BRANCH" --pretty=format:"- %s")
DIFF_STAT=$(git diff --shortstat main..."$TARGET_BRANCH")
echo "DEVLOG_COMMIT_COUNT=$COMMIT_COUNT"
echo "DEVLOG_COMMIT_MESSAGES<<EOF"
echo "$COMMIT_MESSAGES"
echo "EOF"
echo "DEVLOG_DIFF_STAT=$DIFF_STAT"

echo "=== Step 3: Merge to main ==="
git merge "$TARGET_BRANCH" --no-edit || { echo "FAIL: merge conflict"; git merge --abort; exit 1; }
echo "Merge successful"

echo "=== Step 4: Verify merge ==="
if ! git branch --merged main | grep -q "$TARGET_BRANCH"; then
  echo "FAIL: branch not fully merged into main"
  exit 1
fi
echo "Branch fully merged"

echo "=== Step 5: Remove worktree ==="
git worktree remove "$TARGET_CWD" || { echo "FAIL: worktree removal failed"; exit 1; }
echo "Worktree removed"

echo "=== Step 6: Delete branch ==="
git branch -d "$TARGET_BRANCH" || { echo "FAIL: branch deletion failed (may not be fully merged)"; exit 1; }
echo "Branch deleted"

echo ""
echo "===== Done ====="
echo "Merge and cleanup complete"
echo "- Branch: $TARGET_BRANCH → main"
echo "- Worktree: removed"
echo "- Branch: deleted"
```

## Step 3: Delete Discord thread

After script succeeds, find and delete the task via MCP:

1. `bot_tasks(action="list")` to list all tasks
2. Find the task whose `branch` matches TARGET_BRANCH (note: task's cwd may have been changed to main path, prefer matching by branch)
3. `bot_tasks(action="delete", task_id="<channel_id>", cascade=true)` to delete

If no matching task found, skip this step.

## Step 4: Write Dev Log

**After script succeeds, this step is mandatory.** Use `/devlog` skill to write the merge record to database. The `DEVLOG_` prefixed info from script output will be automatically recognized by the devlog skill.

## Step 5: Mark associated Idea as Done

Query Processing Ideas:

```
bot_ideas(action="list", project="<project name>", status="Processing")
```

If a matching record is found (determined by branch name or task description), update its status to Done:

```
bot_ideas(action="update", idea_id="<id>", status="Done")
```

If no Processing Idea found, skip this step.

## Safety rules

- Use `git branch -d` (safe delete), never `-D`
- Abort and report on merge conflicts, never force merge
- Merge is executed in the main worktree, not in the worktree being removed

**Execute the script above immediately as a single command. If the script fails, report the specific FAIL reason and do not proceed with subsequent steps.**
