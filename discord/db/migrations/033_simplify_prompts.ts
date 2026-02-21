import type { Migration } from '../migrate.js';

/**
 * 精简 orchestrator prompts：从"怎么做"转向"做什么 + 规则"
 *
 * 改动的 prompt：
 * - orchestrator.conflict_review   — 移除手把手 bash 步骤
 * - orchestrator.task_review       — 移除编号步骤
 * - orchestrator.task.requirements — 编号列表 → 规则
 * - orchestrator.task.research_rules — 精简 + 移除未使用的 TASK_ID 变量
 * - orchestrator.phase_review      — 移除引导性检查问题
 * - orchestrator.reviewer_init     — 精简职责描述
 */
const migration: Migration = {
  version: 33,
  name: 'simplify_prompts',

  up(db) {
    const now = Date.now();

    db.prepare(`UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?`).run(
      `## Merge Conflict: {{TASK_LABEL}}
Branch \`{{BRANCH_NAME}}\` could not be merged into \`{{GOAL_BRANCH}}\`.
Task: {{TASK_DESCRIPTION}}
Goal worktree: \`{{GOAL_WORKTREE_DIR}}\`

Resolve the conflicts, then report via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.conflict_result"
- \`payload\`: \`{ "resolved": true|false, "summary": "..." }\``,
      now, 'orchestrator.conflict_review',
    );

    db.prepare(`UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?`).run(
      `## Review: {{TASK_LABEL}}
Description: {{TASK_DESCRIPTION}}
Branch: \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

Run \`/code-audit\` on the branch changes, then report via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass"|"fail", "summary": "...", "issues": [] }\``,
      now, 'orchestrator.task_review',
    );

    db.prepare(`UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?`).run(
      `## Requirements
- Implement the task; build and tests must pass
- Self-review with \`/code-audit\` before committing
- Do not modify code unrelated to this task
- Report completion or blockers via \`bot_task_event\` (see protocols below)`,
      now, 'orchestrator.task.requirements',
    );

    db.prepare(`UPDATE prompt_configs SET template = ?, variables = ?, updated_at = ? WHERE key = ?`).run(
      `## Research Task
Research only — do not write implementation code.
When done, report findings via \`task.feedback\` with \`type: "replan"\` (see Feedback Protocol).`,
      JSON.stringify([]),
      now, 'orchestrator.task.research_rules',
    );

    db.prepare(`UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?`).run(
      `Phase {{PHASE_NUMBER}} of "{{GOAL_NAME}}" — all tasks reviewed and merged.

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
      now, 'orchestrator.phase_review',
    );

    db.prepare(`UPDATE prompt_configs SET template = ?, updated_at = ? WHERE key = ?`).run(
      `You are the **code reviewer** for Goal "{{GOAL_NAME}}" (branch: \`{{GOAL_BRANCH}}\`).
Goal ID: \`{{GOAL_ID}}\`

Responsibilities:
- Review completed task changes via \`/code-audit\` when requested
- Log non-critical findings via \`bot_goal_todos\` (\`action: "add"\`, \`goal_id: "{{GOAL_ID}}"\`, \`source: "reviewer"\`, \`priority\`: 重要/高/中/低)
- Report review verdict via \`bot_task_event\`

**No action needed now — reply \`Ready\` when you are ready.**`,
      now, 'orchestrator.reviewer_init',
    );
  },

  down(db) {
    // 回滚：恢复旧模板（仅用于紧急回退，内容从 git 历史恢复）
    const now = Date.now();
    db.prepare(`UPDATE prompt_configs SET updated_at = ? WHERE key IN (?, ?, ?, ?, ?, ?)`)
      .run(now,
        'orchestrator.conflict_review',
        'orchestrator.task_review',
        'orchestrator.task.requirements',
        'orchestrator.task.research_rules',
        'orchestrator.phase_review',
        'orchestrator.reviewer_init',
      );
  },
};

export default migration;
