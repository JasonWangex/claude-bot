import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 46,
  name: 'add_tech_lead_consultation_prompt',

  up(db) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO prompt_configs
        (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(
      'orchestrator.tech_lead_consultation',
      'orchestrator',
      'Tech Lead 调解咨询',
      '任务卡住或无法继续时，请求 tech lead 介入调解，决定如何推进',
      `## Situation Requires Your Attention

**Goal:** {{GOAL_NAME}} (branch: \`{{GOAL_BRANCH}}\`)

**Situation:** {{SITUATION}}

{{CONTEXT}}

**Stuck / Failed Tasks:**
{{STUCK_TASKS}}

Please investigate the situation. Check the relevant code, errors, and task history, then decide the best path forward. Your options:

- **retry** — retry a specific task (transient error or needs another attempt)
- **skip** — mark a task as skipped and continue the goal
- **replan** — the goal needs to be replanned (fundamental blocker)
- **escalate_user** — truly requires human input (last resort)

Respond via \`bot_task_event\`:
- \`task_id\`: the task you are making a decision about (use one of the task IDs above)
- \`event_type\`: \`"review.failed_task"\`
- \`payload\`: \`{ "verdict": "retry" | "skip" | "replan" | "escalate_user", "reason": "..." }\`

Investigate thoroughly before escalating to user. Only use \`escalate_user\` if there is no way to proceed without human input.`,
      JSON.stringify(['GOAL_NAME', 'GOAL_BRANCH', 'SITUATION', 'CONTEXT', 'STUCK_TASKS']),
      now,
      now,
    );
  },

  down(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.tech_lead_consultation');
  },
};

export default migration;
