import type { Migration } from '../migrate.js';

const NEW_TEMPLATE = `## Review: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

If there are code changes, run \`/code-audit\`. If this is a research/exploration task (no diff), review the logical completeness and quality of the findings instead.

Report result via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass"|"fail", "summary": "...", "issues": [] }\``;

const OLD_TEMPLATE = `## Review: {{TASK_LABEL}}
Description: {{TASK_DESCRIPTION}}
Branch: \`{{BRANCH_NAME}}\`
\`\`\`
{{DIFF_STATS}}
\`\`\`

Run \`/code-audit\` on the branch changes, then report via \`bot_task_event\`:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass"|"fail", "summary": "...", "issues": [] }\``;

const migration: Migration = {
  version: 43,
  name: 'update_task_review_prompt',

  up(db) {
    const now = Date.now();
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE \`key\` = 'orchestrator.task_review'
    `).run(NEW_TEMPLATE, now);
  },

  down(db) {
    const now = Date.now();
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, updated_at = ?
      WHERE \`key\` = 'orchestrator.task_review'
    `).run(OLD_TEMPLATE, now);
  },
};

export default migration;
