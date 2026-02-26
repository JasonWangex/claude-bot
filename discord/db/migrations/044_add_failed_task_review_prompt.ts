import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 44,
  name: 'add_failed_task_review_prompt',

  up(db) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO prompt_configs
        (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(
      'orchestrator.failed_task_review',
      'orchestrator',
      '失败任务审核',
      '任务失败后发给 tech lead，由 tech lead 决定是否 retry',
      `## Task Failed: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Error:** \`{{ERROR}}\`

Decide: can this be automatically retried/fixed, or does it need human intervention?

Report via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.failed_task"
- \`payload\`: \`{ "verdict": "retry" | "skip", "reason": "..." }\`

Use \`retry\` if the error is transient or recoverable. Use \`skip\` if it requires human intervention.`,
      JSON.stringify(['TASK_LABEL', 'TASK_DESCRIPTION', 'ERROR', 'TASK_ID']),
      now,
      now,
    );
  },

  down(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.failed_task_review');
  },
};

export default migration;
