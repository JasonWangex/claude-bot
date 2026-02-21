import type { Migration } from '../migrate.js';

/**
 * Migration 018: 补充遗漏的 orchestrator prompts
 *
 * 新增：
 * - orchestrator.check_in: 任务 session 结束后无事件上报时的催促消息
 * - orchestrator.phase_review: Phase 所有任务审核完毕后的全局评估
 */
const migration: Migration = {
  version: 18,
  name: 'add_missing_orchestrator_prompts',

  up(db) {
    const now = Date.now();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO prompt_configs
        (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      // orchestrator.check_in
      insert.run(
        'orchestrator.check_in',
        'orchestrator',
        'Check-in 监工',
        '任务 session 结束后无事件上报时的催促消息',
        `Task {{TASK_LABEL}} session has ended, but no completion report was received.

Please confirm your status:
- If you have completed the task: ensure your changes are committed, then call \`bot_task_event\` to report \`task.completed\` with a summary
- If you encountered an issue: call \`bot_task_event\` to report \`task.feedback\` with details
- If you are still working: continue your work
{{REVIEW_ISSUES}}`,
        JSON.stringify(['TASK_LABEL', 'REVIEW_ISSUES']),
        null,
        0,
        now,
        now,
      );

      // orchestrator.phase_review
      insert.run(
        'orchestrator.phase_review',
        'orchestrator',
        'Phase 全局评估',
        'Phase 所有任务审核完毕后的全局评估 prompt',
        `Phase {{PHASE_NUMBER}} of Goal "{{GOAL_NAME}}" — all tasks have been reviewed and merged.

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
        JSON.stringify(['PHASE_NUMBER', 'GOAL_NAME', 'TASK_REVIEW_SUMMARIES', 'PROGRESS_SUMMARY', 'PHASE_TASK_ID']),
        null,
        0,
        now,
        now,
      );
    })();
  },

  down(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key IN (?, ?)`).run(
      'orchestrator.check_in',
      'orchestrator.phase_review',
    );
  },
};

export default migration;
