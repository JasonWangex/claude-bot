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
- Implement the task; build and tests must pass
- Self-review with \`/code-audit\` before committing
- Do not modify code unrelated to this task
- Report completion or blockers via \`bot_task_event\` (see protocols below)`,
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
    template: `## Research Task
Research only — do not write implementation code.
When done, report findings via \`task.feedback\` with \`type: "replan"\` (see Feedback Protocol).`,
    variables: [],
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

  // ---- orchestrator.phase_review (Phase 全局评估) ----
  entries.push({
    key: 'orchestrator.phase_review',
    category: 'orchestrator',
    name: 'Phase 全局评估',
    description: 'Phase 所有任务审核完毕后的全局评估 prompt',
    template: `Phase {{PHASE_NUMBER}} of "{{GOAL_NAME}}" — all tasks reviewed and merged.

## Task Reviews
{{TASK_REVIEW_SUMMARIES}}

## Progress
{{PROGRESS_SUMMARY}}

Evaluate phase quality and decide:
- **continue**: proceed to the next phase
- **replan**: issues require task plan changes

Call \`bot_task_event\`:
- \`task_id\`: "{{PHASE_TASK_ID}}"
- \`event_type\`: "review.phase_result"
- \`payload\`: \`{ "decision": "continue"|"replan", "summary": "...", "issues": [] }\``,
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

  // ---- orchestrator.tech_lead_init (Tech Lead 初始化) ----
  entries.push({
    key: 'orchestrator.tech_lead_init',
    category: 'orchestrator',
    name: 'Tech Lead 初始化',
    description: 'Goal Drive 启动时发送给 tech lead channel，告知角色和上下文',
    template: `You are the **tech lead** for Goal "{{GOAL_NAME}}" (branch: \`{{GOAL_BRANCH}}\`).
Goal ID: \`{{GOAL_ID}}\`

Responsibilities:
- Review completed task changes via \`/code-audit\` when requested
- Resolve merge conflicts when tasks cannot be merged automatically
- Evaluate phase quality and decide continue/replan after each phase completes
- **Directly modify tasks** when needed (add/update/remove/skip/stop tasks)
- Log non-critical findings via \`bot_goal_todos\` (\`action: "add"\`, \`goal_id: "{{GOAL_ID}}"\`, \`source: "tech-lead"\`, \`priority\`: 重要/高/中/低)
- Report review verdict via \`bot_task_event\`

Task modification tools (\`bot_goal_tasks\`):
- \`add\` — add a new task (requires task_id + description; optional: type, phase, complexity)
- \`update\` — modify task fields (description, type, phase, complexity)
- \`remove\` — cancel a task (sets status=cancelled)
- \`skip\` — skip a task
- \`stop\` — hard stop a running task (kill session, mark failed)
- \`pause\` — soft pause (session continues but won't advance)
- \`retry\` — resume in existing channel
- \`reset\` — full reset, start fresh
- \`nudge\` — light-push to let agent self-assess

Task ID format: \`g{{GOAL_SEQ}}t<N>\` (e.g. \`g{{GOAL_SEQ}}t8\`)
Valid types: 代码, 手动, 调研, 占位, 测试

**No action needed now — reply \`Ready\` when you are ready.**`,
    variables: ['GOAL_NAME', 'GOAL_BRANCH', 'GOAL_ID', 'GOAL_SEQ'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.task_review (Per-task 审核) ----
  entries.push({
    key: 'orchestrator.task_review',
    category: 'orchestrator',
    name: 'Per-task 审核',
    description: '任务完成后在独立 audit sub-session 中执行的审核请求（已在 goal worktree 中）',
    template: `## Review: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

If there are code changes, run \`/code-audit\`. If this is a research/exploration task (no diff), review the logical completeness and quality of the findings instead.

Report result via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass"|"fail", "summary": "...", "issues": [] }\``,
    variables: ['TASK_LABEL', 'TASK_DESCRIPTION', 'BRANCH_NAME', 'DIFF_STATS', 'TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.failed_task_review (任务失败后 tech lead 裁决) ----
  entries.push({
    key: 'orchestrator.failed_task_review',
    category: 'orchestrator',
    name: '失败任务审核',
    description: '任务失败后发给 tech lead，由 tech lead 决定是否 retry',
    template: `## Task Failed: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Error:** \`{{ERROR}}\`

Decide: can this be automatically retried/fixed, or does it need human intervention?

Report via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.failed_task"
- \`payload\`: \`{ "verdict": "retry" | "skip", "reason": "..." }\`

Use \`retry\` if the error is transient or recoverable. Use \`skip\` if it requires human intervention.`,
    variables: ['TASK_LABEL', 'TASK_DESCRIPTION', 'ERROR', 'TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.conflict_review (冲突解决请求，发给 tech lead) ----
  entries.push({
    key: 'orchestrator.conflict_review',
    category: 'orchestrator',
    name: '冲突解决请求',
    description: 'Merge 冲突时发给 tech lead 让其手动处理',
    template: `## Merge Conflict: {{TASK_LABEL}}
Branch \`{{BRANCH_NAME}}\` could not be merged into \`{{GOAL_BRANCH}}\`.
Task: {{TASK_DESCRIPTION}}
Goal worktree: \`{{GOAL_WORKTREE_DIR}}\`

Resolve the conflicts, then report via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.conflict_result"
- \`payload\`: \`{ "resolved": true|false, "summary": "..." }\``,
    variables: ['TASK_LABEL', 'BRANCH_NAME', 'GOAL_BRANCH', 'TASK_DESCRIPTION', 'GOAL_WORKTREE_DIR', 'TASK_ID'],
    parentKey: null,
    sortOrder: 0,
  });

  // ---- orchestrator.feedback_investigation (blocked_feedback 任务的调查) ----
  entries.push({
    key: 'orchestrator.feedback_investigation',
    category: 'orchestrator',
    name: 'Feedback 调查',
    description: '任务上报 blocked_feedback 后，AI 调查原因并决定下一步行动',
    template: `Task {{TASK_LABEL}} reported feedback and needs investigation.

## Task
Description: {{TASK_DESCRIPTION}}
Goal branch: {{GOAL_BRANCH}}

## Feedback
Type: {{FEEDBACK_TYPE}}
Reason: {{FEEDBACK_REASON}}
{{FEEDBACK_DETAILS}}
## Your Job
Investigate the feedback, check the codebase, and determine the best action:
- **continue**: The issue can be resolved in the current context — fix it and continue
- **retry**: The task needs a fresh start
- **replan**: The feedback reveals a structural issue requiring task plan changes
- **escalate**: Cannot determine the right action — needs human judgment

Call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "task.feedback"
- \`payload\`: \`{ "action": "continue|retry|replan|escalate", "reason": "..." }\``,
    variables: ['TASK_LABEL', 'TASK_DESCRIPTION', 'GOAL_BRANCH', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS', 'TASK_ID'],
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
