---
name: commit
description: >
  Review code changes and commit. Triggers: "commit", "/commit".
  First performs a code review on staged/unstaged changes, then commits
  if no issues are found.
---

# Commit Skill

Review current code changes and auto-commit if no issues found.

## Workflow

### Step 1: Check changes

Run `git status` and `git diff` (both staged and unstaged) to understand all pending changes.

If there are no changes, inform the user and stop.

### Step 2: Code review (using /code-audit)

Invoke `/code-audit` skill on **files involved in this diff only** (not the entire project).

Provide the changed file list and diff content as context for a focused 4-phase audit:
1. Code quality — complexity, type safety, error handling of changed code
2. Data flow — whether changes break existing data flows
3. Frontend-backend interaction — API contract consistency
4. Logic & exception handling — complete error paths

> Note: For small changes (<5 files and <100 lines diff), simplify to Phase 1 and Phase 4 only.

### Step 3: Decide next action based on review

**If CRITICAL or HIGH issues found:**
- List all issues with fix suggestions
- Ask the user whether to fix them first
- Do not auto-commit

**If only MEDIUM/LOW issues or none:**
- Briefly report review results (list MEDIUM/LOW if any)
- Stage all changes (`git add` relevant files)
- Generate commit message based on changes
- Execute `git commit`

### Step 4: Report result

After completion (whether committed or blocked by issues), append the current branch:

```
Current branch: <branch-name>
```

### Commit Message Convention

Follow Conventional Commits format:

```
type(scope): short description

Optional detailed explanation
```

- Match the project's convention by checking `git log` history
- Describe "why" rather than just "what"
- If `$ARGUMENTS` is provided, use it as reference or directly as the commit message
