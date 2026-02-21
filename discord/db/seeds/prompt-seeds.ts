/**
 * Prompt 配置种子数据
 *
 * 在 migration 001/009 中调用，将 Orchestrator 模板写入数据库。
 * Skill prompt 已全部迁移到 ~/.claude/skills/ 直读文件，不再经 DB 中转。
 *
 * 注意：seed 使用 INSERT OR IGNORE，已有记录不会被覆盖。
 * 内容变更通过 migration（如 011_update_prompts）的 UPDATE 语句应用。
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

interface SeedEntry {
  key: string;
  category: 'orchestrator';
  name: string;
  description: string;
  template: string;
  variables: string[];
  parentKey: string | null;
  sortOrder: number;
}

// 统一的 detail_plan NOTE 措辞（5 个 section 共用）
const DETAIL_PLAN_NOTE = `**NOTE**: This detailed plan is from the goal planning phase. Follow it where applicable, but adapt to actual codebase constraints.`;

export function seedPromptConfigs(db: Database.Database): void {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO prompt_configs (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
    VALUES (@key, @category, @name, @description, @template, @variables, @parent_key, @sort_order, @created_at, @updated_at)
  `);

  const entries: SeedEntry[] = [];

  // ================================================================
  // Orchestrator 层 — 内联模板
  // ================================================================

  // ---- orchestrator.task (主模板) ----
  entries.push({
    key: 'orchestrator.task',
    category: 'orchestrator',
    name: '简单任务执行',
    description: '简单代码任务的直接执行（无 plan 阶段）',
    template: `You are a subtask executor for Goal "{{GOAL_NAME}}".

## Environment
- You are working in a **git worktree** dedicated to this task
- Commit with descriptive messages: \`<type>(<scope>): <summary>\` (e.g. \`feat(auth): add login endpoint\`, \`fix(db): handle null input\`)

## Current Task
ID: {{TASK_LABEL}}
Type: {{TASK_TYPE}}
Description: {{TASK_DESCRIPTION}}`,
    variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_TYPE', 'TASK_DESCRIPTION'],
    parentKey: null,
    sortOrder: 0,
  });

  entries.push({
    key: 'orchestrator.task.detail_plan',
    category: 'orchestrator',
    name: '任务详细计划 section',
    description: '注入来自 Goal body 的详细计划',
    template: `{{DETAIL_PLAN_TEXT}}

${DETAIL_PLAN_NOTE}`,
    variables: ['DETAIL_PLAN_TEXT'],
    parentKey: 'orchestrator.task',
    sortOrder: 1,
  });

  entries.push({
    key: 'orchestrator.task.requirements',
    category: 'orchestrator',
    name: '通用要求 section',
    description: '任务执行的通用要求',
    template: `## Requirements
1. Implement the task, ensuring build and tests pass
2. Before committing, use \`/code-audit\` to self-review your changes — fix any issues found
3. After passing self-review, commit your changes
4. Call \`bot_task_event\` to report \`task.completed\` (see Completion Protocol)
5. If you encounter blockers, call \`bot_task_event\` to report \`task.feedback\` (see Feedback Protocol)
6. Do not modify code unrelated to this task`,
    variables: [],
    parentKey: 'orchestrator.task',
    sortOrder: 3,
  });

  // feedback_protocol 已合并 when_to_feedback 的触发场景
  entries.push({
    key: 'orchestrator.task.feedback_protocol',
    category: 'orchestrator',
    name: 'Feedback 协议 section',
    description: '任务遇到问题时的反馈机制（含触发场景）',
    template: `## Completion Protocol
When your task is done (code implemented, /code-audit passed, committed), call \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "task.completed"
- \`payload\`: \`{ "summary": "brief description of what was done" }\`

Then **stop working**.

## Feedback Protocol
When you encounter any of these situations, call \`bot_task_event\` and **stop working**:
- **Blocked:** Technical blocker you cannot resolve. Use \`type: "blocked"\`.
- **Needs Clarification:** Ambiguous or conflicting requirements. Use \`type: "clarify"\`.
- **Scope Mismatch:** Task requires changes far beyond its description. Use \`type: "replan"\`.
- **Dependency Issue:** A completed dependency is incorrect. Use \`type: "blocked"\`.

Call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "task.feedback"
- \`payload\`:
\`\`\`json
{
  "type": "replan" | "blocked" | "clarify",
  "reason": "brief summary",
  "details": {}
}
\`\`\`

The orchestrator will detect your event automatically.`,
    variables: ['TASK_ID'],
    parentKey: 'orchestrator.task',
    sortOrder: 4,
  });

  entries.push({
    key: 'orchestrator.task.research_rules',
    category: 'orchestrator',
    name: '调研任务规则 section',
    description: '调研类型任务的特殊规则',
    template: `## Research Task Rules
This is a **research task**. When you finish your research:
1. You **MUST** call \`bot_task_event\` with \`event_type: "task.feedback"\` before ending
2. Use \`type: "replan"\` with your findings in \`details\`
3. Example payload:
\`\`\`json
{
  "type": "replan",
  "reason": "Research completed — findings may affect task plan",
  "details": {
    "findings": "Your research conclusions here",
    "recommendations": ["actionable suggestion 1", "suggestion 2"],
    "affectedTasks": ["t3", "t4"]
  }
}
\`\`\`
4. Do NOT write implementation code — only research, document, and report back`,
    variables: ['TASK_ID'],
    parentKey: 'orchestrator.task',
    sortOrder: 5,
  });

  // when_to_feedback 已合并入 feedback_protocol，不再单独存在

  entries.push({
    key: 'orchestrator.task.placeholder_rules',
    category: 'orchestrator',
    name: '占位任务规则 section',
    description: '占位任务的特殊规则',
    template: `## Placeholder Task
This is a **placeholder task**. It exists as a structural marker in the task graph.
- Placeholder tasks are normally NOT dispatched automatically.
- If you are seeing this, the task was triggered manually or by an unusual condition.
- **Do not write code.** Instead, write a \`type: "clarify"\` feedback asking the orchestrator why this task was dispatched, then stop.`,
    variables: [],
    parentKey: 'orchestrator.task',
    sortOrder: 7,
  });

  // ---- orchestrator.replan (单模板) ----
  entries.push({
    key: 'orchestrator.replan',
    category: 'orchestrator',
    name: '任务重规划',
    description: '分析 feedback 并通过 bot_task_event 上报结构化计划更新',
    template: `You are a task replanner for a software development goal orchestrator.
Your job is to analyze feedback from a subtask and produce a structured plan update.

## Goal
Name: {{GOAL_NAME}}
{{GOAL_BODY}}
{{COMPLETION_CRITERIA}}

## Current Tasks
{{CURRENT_TASKS}}

## Replan Trigger
Task: {{TRIGGER_TASK_ID}}
Feedback type: {{FEEDBACK_TYPE}}
Reason: {{FEEDBACK_REASON}}
{{FEEDBACK_DETAILS}}
{{COMPLETED_DIFF_STATS}}
## Constraints
1. **NEVER modify completed or skipped tasks** — their IDs: {{IMMUTABLE_COMPLETED}}
2. **NEVER modify running or dispatched tasks** — their IDs: {{IMMUTABLE_RUNNING}}
3. New task IDs must not collide with existing IDs
4. Tasks are ordered by phase (phase 1 runs first, then phase 2, etc.). Tasks in the same phase run in parallel.
5. Keep changes minimal — only modify what the feedback necessitates
6. Preserve the overall goal direction

## Output
Call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "replan.result"
- \`payload\`:
\`\`\`json
{
  "changes": [
    { "action": "add", "task": { "id": "t8", "description": "...", "type": "代码", "phase": 3, "complexity": "simple" } },
    { "action": "modify", "taskId": "t5", "updates": { "description": "new desc", "phase": 2, "complexity": "complex" } },
    { "action": "remove", "taskId": "t7", "reason": "superseded by t8" }
  ],
  "reasoning": "Explanation of why these changes are needed",
  "impactLevel": "low" | "medium" | "high"
}
\`\`\`

Impact levels (assessed by affected pending tasks):
- low: affects ≤1 pending task (description tweaks, phase adjustment)
- medium: affects 2-3 pending tasks (task additions/removals, but overall direction unchanged)
- high: affects ≥4 pending tasks, OR significant restructuring with both add+remove that changes direction
Note: low/medium changes are auto-applied; high requires user approval.

Valid task types: 代码, 手动, 调研, 占位
Task granularity: split by **feature/functionality**, NOT by technical layer. One feature = one task, even if it touches frontend + backend + API.
Valid complexity (for 代码 tasks): "simple" (straightforward logic, has patterns to follow) or "complex" (needs architecture design or cross-module coordination). Default: "simple"
Valid actions: add, modify, remove

If no changes are needed, call \`bot_task_event\` with: \`{ "changes": [], "reasoning": "...", "impactLevel": "low" }\``,
    variables: ['GOAL_NAME', 'GOAL_BODY', 'COMPLETION_CRITERIA', 'CURRENT_TASKS', 'TRIGGER_TASK_ID', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS', 'COMPLETED_DIFF_STATS', 'IMMUTABLE_COMPLETED', 'IMMUTABLE_RUNNING', 'TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.conflict_resolver (单模板) — 不改动 ----
  entries.push({
    key: 'orchestrator.conflict_resolver',
    category: 'orchestrator',
    name: 'Git 冲突解决',
    description: 'AI 自动解决 Git 合并冲突',
    template: `You are resolving Git merge conflicts. Branch \`{{SUBTASK_BRANCH}}\` is being merged into the current branch.

Subtask description: {{TASK_DESCRIPTION}}

The following files have conflicts:
{{CONFLICT_FILES}}

Instructions:
1. Read each conflicted file to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>>)
2. HEAD is the current goal branch (accumulated work from other subtasks)
3. The incoming changes are from the subtask branch (the work described above)
4. Resolve by keeping BOTH sides' valid changes — do not discard either side's work
5. Use the Edit tool to fix each file, removing all conflict markers

Common patterns:
- Import conflicts: keep all imports from both sides
- package.json / config files: merge both sets of entries
- Adjacent code changes: include both additions in the correct order
- Same function modified: carefully combine the logic from both sides

Rules:
- Do NOT run git add, git commit, or any git commands
- Do NOT run install, build, or test commands
- ONLY edit the conflicted files to resolve the conflicts`,
    variables: ['SUBTASK_BRANCH', 'TASK_DESCRIPTION', 'CONFLICT_FILES'],
    parentKey: null,
    sortOrder: 0,
  });





  // ---- orchestrator.phase_review (Phase 全局评估) ----
  entries.push({
    key: 'orchestrator.phase_review',
    category: 'orchestrator',
    name: 'Phase 全局评估',
    description: 'Phase 所有任务审核完毕后的全局评估 prompt',
    template: `Phase {{PHASE_NUMBER}} of Goal "{{GOAL_NAME}}" — all tasks have been reviewed and merged.

## Task Review Summaries
{{TASK_REVIEW_SUMMARIES}}

## Progress
{{PROGRESS_SUMMARY}}

## Your Role
Evaluate the overall quality and progress of this phase:
1. Are the completed tasks consistent with each other?
2. Does the codebase remain in a healthy state?
3. Are there any concerns for upcoming phases?

Then decide:
- **continue**: Everything looks good, proceed to the next phase
- **replan**: Issues found that require task plan adjustments

Call \`bot_task_event\` with:
- \`task_id\`: "{{PHASE_TASK_ID}}"
- \`event_type\`: "review.phase_result"
- \`payload\`: \`{ "decision": "continue" | "replan", "summary": "brief evaluation", "issues": [] }\`

If you choose "replan", include specific issues and recommendations in the payload.`,
    variables: ['PHASE_NUMBER', 'GOAL_NAME', 'TASK_REVIEW_SUMMARIES', 'PROGRESS_SUMMARY', 'PHASE_TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.check_in (通用监工 prompt) ----
  entries.push({
    key: 'orchestrator.check_in',
    category: 'orchestrator',
    name: 'Check-in 监工',
    description: '任务 session 结束后无事件上报时的催促消息',
    template: `Task {{TASK_LABEL}} session has ended, but no completion report was received.

Please confirm your status:
- If you have completed the task: ensure your changes are committed, then call \`bot_task_event\` to report \`task.completed\` with a summary
- If you encountered an issue: call \`bot_task_event\` to report \`task.feedback\` with details
- If you are still working: continue your work
{{REVIEW_ISSUES}}`,
    variables: ['TASK_LABEL', 'REVIEW_ISSUES'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.reviewer_init (审核员初始化) ----
  entries.push({
    key: 'orchestrator.reviewer_init',
    category: 'orchestrator',
    name: 'Reviewer 初始化',
    description: 'Goal Drive 启动时发送给 reviewer channel，告知角色和上下文',
    template: `You are the **code reviewer** for Goal "{{GOAL_NAME}}" (branch: \`{{GOAL_BRANCH}}\`).

This goal has **{{TASK_COUNT}} tasks** to complete. Your responsibilities:

1. Review each completed task's code changes when prompted
2. Evaluate whether the implementation matches the task description
3. Check for quality issues, security concerns, or missed requirements
4. At the end of each phase, evaluate overall progress and decide whether to continue or replan

You will receive review requests automatically. For each review, report your findings using \`bot_task_event\`.

**No action needed now — wait for the first review request.**`,
    variables: ['GOAL_NAME', 'GOAL_BRANCH', 'TASK_COUNT'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.task_review (Per-task 审核) ----
  entries.push({
    key: 'orchestrator.task_review',
    category: 'orchestrator',
    name: 'Per-task 审核',
    description: '任务完成后发送给 reviewer channel 的审核请求',
    template: `## Task Review: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
**Diff stats:**
\`\`\`
{{DIFF_STATS}}
\`\`\`

Please review this completed task:
1. Use a sub-agent to checkout branch \`{{BRANCH_NAME}}\` and run \`/code-audit\` to audit the code changes
2. Evaluate whether the implementation matches the task description
3. Check for any quality issues, security concerns, or missed requirements

Then call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass" | "fail", "summary": "brief review summary", "issues": [] }\`

If the verdict is "fail", include specific issues that need to be fixed.`,
    variables: ['TASK_LABEL', 'TASK_DESCRIPTION', 'BRANCH_NAME', 'DIFF_STATS', 'TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.conflict_review (冲突解决请求，发给 reviewer) ----
  entries.push({
    key: 'orchestrator.conflict_review',
    category: 'orchestrator',
    name: '冲突解决请求',
    description: 'AI 无法自动解决 merge 冲突时，发给 reviewer 让其手动处理',
    template: `## Merge Conflict Resolution Needed: {{TASK_LABEL}}

Branch \`{{BRANCH_NAME}}\` could not be automatically merged into \`{{GOAL_BRANCH}}\`.

**Task:** {{TASK_DESCRIPTION}}
**AI resolution failed:** {{AI_ERROR}}

## Steps

1. Navigate to the goal worktree:
   \`\`\`bash
   cd {{GOAL_WORKTREE_DIR}}
   \`\`\`

2. Retry the merge:
   \`\`\`bash
   git merge {{BRANCH_NAME}}
   \`\`\`

3. Resolve all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) in each conflicted file.
   Keep valid changes from **both** sides — do not discard either side's work.

4. Complete the merge:
   \`\`\`bash
   git add -A && git commit --no-edit
   \`\`\`

5. Report the result via \`bot_task_event\`:
   - \`task_id\`: "{{TASK_ID}}"
   - \`event_type\`: "review.conflict_result"
   - \`payload\`: \`{ "resolved": true, "summary": "how conflicts were resolved" }\`

If you cannot resolve the conflict, report:
   - \`payload\`: \`{ "resolved": false, "summary": "why it cannot be resolved" }\``,
    variables: ['TASK_LABEL', 'BRANCH_NAME', 'GOAL_BRANCH', 'TASK_DESCRIPTION', 'AI_ERROR', 'GOAL_WORKTREE_DIR', 'TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ================================================================
  // 批量写入
  // ================================================================

  const insertAll = db.transaction(() => {
    for (const entry of entries) {
      stmt.run({
        key: entry.key,
        category: entry.category,
        name: entry.name,
        description: entry.description,
        template: entry.template,
        variables: JSON.stringify(entry.variables),
        parent_key: entry.parentKey,
        sort_order: entry.sortOrder,
        created_at: now,
        updated_at: now,
      });
    }
  });

  insertAll();
  logger.info(`[Seed] Inserted ${entries.length} prompt configs`);
}
