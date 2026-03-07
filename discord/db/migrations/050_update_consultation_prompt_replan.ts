import type { Migration } from '../migrate.js';

const NEW_TEMPLATE = `## Situation Requires Your Attention

**Goal:** {{GOAL_NAME}} (branch: \`{{GOAL_BRANCH}}\`)

**Situation:** {{SITUATION}}

{{CONTEXT}}

**Stuck / Failed Tasks:**
{{STUCK_TASKS}}

Please investigate and decide the best path forward:

- **retry** — retry a specific task (transient error or needs another attempt)
- **skip** — mark a task as skipped and continue the goal
- **escalate_user** — truly requires human input (last resort)

Respond via \`bot_task_event\`:
- \`task_id\`: the task you are making a decision about
- \`event_type\`: \`"review.failed_task"\`
- \`payload\`: \`{ "verdict": "retry" | "skip" | "escalate_user", "reason": "..." }\`

If the situation requires **structural task plan changes** (wrong scope, fundamentally broken plan), invoke the replan skill instead:
\`/goal-replan {{GOAL_ID}}\`

Only use \`escalate_user\` if there is no way to proceed without human input.`;

const OLD_TEMPLATE = `## Situation Requires Your Attention

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

Investigate thoroughly before escalating to user. Only use \`escalate_user\` if there is no way to proceed without human input.`;

const NEW_VARIABLES = JSON.stringify(['GOAL_NAME', 'GOAL_BRANCH', 'GOAL_ID', 'SITUATION', 'CONTEXT', 'STUCK_TASKS']);
const OLD_VARIABLES = JSON.stringify(['GOAL_NAME', 'GOAL_BRANCH', 'SITUATION', 'CONTEXT', 'STUCK_TASKS']);

const migration: Migration = {
  version: 50,
  name: 'update_consultation_prompt_replan',

  up(db) {
    const now = Date.now();
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, variables = ?, updated_at = ?
      WHERE key = ?
    `).run(NEW_TEMPLATE, NEW_VARIABLES, now, 'orchestrator.tech_lead_consultation');
  },

  down(db) {
    const now = Date.now();
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, variables = ?, updated_at = ?
      WHERE key = ?
    `).run(OLD_TEMPLATE, OLD_VARIABLES, now, 'orchestrator.tech_lead_consultation');
  },
};

export default migration;
