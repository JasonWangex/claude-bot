import type { Migration } from '../migrate.js';

/**
 * 移除 orchestrator.conflict_resolver prompt 并更新 orchestrator.conflict_review
 *
 * 原有两步流程：
 *   1. AI 自动尝试解决冲突（conflict_resolver）
 *   2. AI 失败时转交 reviewer（conflict_review）
 *
 * 简化为：冲突发生时直接转交 reviewer，跳过 AI 自动解决步骤。
 *
 * 变更：
 * - DELETE orchestrator.conflict_resolver
 * - UPDATE orchestrator.conflict_review：移除 AI_ERROR 变量和相关文案
 */

const NEW_TEMPLATE = `## Merge Conflict Resolution Needed: {{TASK_LABEL}}

Branch \`{{BRANCH_NAME}}\` could not be automatically merged into \`{{GOAL_BRANCH}}\`.

**Task:** {{TASK_DESCRIPTION}}

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
   - \`payload\`: \`{ "resolved": false, "summary": "why it cannot be resolved" }\``;

const NEW_VARIABLES = JSON.stringify([
  'TASK_LABEL', 'BRANCH_NAME', 'GOAL_BRANCH', 'TASK_DESCRIPTION', 'GOAL_WORKTREE_DIR', 'TASK_ID',
]);

const migration: Migration = {
  version: 27,
  name: 'remove_conflict_resolver',

  up(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.conflict_resolver');

    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, variables = ?, description = ?, updated_at = ?
      WHERE key = 'orchestrator.conflict_review'
    `).run(NEW_TEMPLATE, NEW_VARIABLES, 'Merge 冲突时发给 reviewer 让其手动处理', Date.now());
  },

  down(_db) {
    // 不可逆：conflict_resolver 数据已从 seed 中移除，无法完整恢复
  },
};

export default migration;
