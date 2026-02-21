import type { Migration } from '../migrate.js';

/**
 * 更新 orchestrator.task_review prompt：
 * 每次审计现在在独立的 audit sub-session 中运行（session 已在 goal worktree），
 * 不再需要 sub-agent 来 checkout 分支，直接运行 /code-audit。
 */

const NEW_TEMPLATE = `## Task Review: {{TASK_LABEL}}
**Description:** {{TASK_DESCRIPTION}}
**Branch:** \`{{BRANCH_NAME}}\`
**Diff stats:**
\`\`\`
{{DIFF_STATS}}
\`\`\`

Please review this completed task:
1. Run \`/code-audit\` on branch \`{{BRANCH_NAME}}\` to audit the code changes (you are already in the goal worktree)
2. Evaluate whether the implementation matches the task description
3. Check for any quality issues, security concerns, or missed requirements

Then call \`bot_task_event\` with:
- \`task_id\`: "{{TASK_ID}}"
- \`event_type\`: "review.task_result"
- \`payload\`: \`{ "verdict": "pass" | "fail", "summary": "brief review summary", "issues": [] }\`

If the verdict is "fail", include specific issues that need to be fixed.`;

const migration: Migration = {
  version: 30,
  name: 'update_task_review_prompt',

  up(db) {
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, description = ?, updated_at = ?
      WHERE key = 'orchestrator.task_review'
    `).run(
      NEW_TEMPLATE,
      '任务完成后在独立 audit sub-session 中执行的审核请求（已在 goal worktree 中）',
      Date.now(),
    );
  },

  down(_db) {
    // 不可逆：旧模板已从 seed 中更新
  },
};

export default migration;
