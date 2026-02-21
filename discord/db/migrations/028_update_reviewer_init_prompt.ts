import type { Migration } from '../migrate.js';

/**
 * 更新 orchestrator.reviewer_init prompt
 *
 * 变更：
 * - 移除 {{TASK_COUNT}} 变量（reviewer 不需要知道总任务数）
 * - 移除 replan 职责描述（replan 决策在 phase_review 中触发，不在 reviewer_init 中声明）
 * - 角色名称从 "code reviewer" 改为 "code orchestrator"
 * - 结束语从 "wait for the first review request" 改为 "echo `Ready`"
 * - 新增 {{GOAL_ID}} 变量，供 reviewer 调用 bot_goal_todos 记录非必要问题
 */

const NEW_TEMPLATE = `You are the **code orchestrator** for Goal "{{GOAL_NAME}}" (branch: \`{{GOAL_BRANCH}}\`).
Goal ID: \`{{GOAL_ID}}\`

Your responsibilities:

1. Review each completed task's code changes when prompted, use \`/code-audit\` to check for quality issues, security concerns, or missed requirements
2. Evaluate whether the implementation matches the task description

When you find non-critical issues (low impact, doesn't block task acceptance), record them via \`bot_goal_todos\`:
- \`action: "add"\`, \`goal_id: "{{GOAL_ID}}"\`, \`source: "reviewer"\`
- Set \`priority\`: \`重要\` (should fix before release) / \`高\` (significant improvement) / \`中\` (nice to have) / \`低\` (trivial)
- Example: content \`auth/login.ts: missing rate limiting\`, \`priority: "高"\`

You will receive review requests automatically. For each review, report your findings using \`bot_task_event\`.

**No action needed now — echo \`Ready\` when you ready**`;

const NEW_VARIABLES = JSON.stringify(['GOAL_NAME', 'GOAL_BRANCH', 'GOAL_ID']);

const migration: Migration = {
  version: 28,
  name: 'update_reviewer_init_prompt',

  up(db) {
    db.prepare(`
      UPDATE prompt_configs
      SET template = ?, variables = ?, updated_at = ?
      WHERE key = 'orchestrator.reviewer_init'
    `).run(NEW_TEMPLATE, NEW_VARIABLES, Date.now());
  },

  down(_db) {
    // 不可逆：旧模板已从 seed 中移除
  },
};

export default migration;
