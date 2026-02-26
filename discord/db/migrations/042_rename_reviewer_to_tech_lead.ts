import type { Migration } from '../migrate.js';

/**
 * 将 reviewer 角色重命名为 tech lead
 *
 * Tech Lead 职责远超代码审查，还包括：
 * - Merge 冲突解决
 * - Phase 质量评估与 continue/replan 决策
 * - Goal 完成后全局代码审计
 *
 * 改动：
 * - orchestrator.reviewer_init → orchestrator.tech_lead_init（key + 内容）
 */
const migration: Migration = {
  version: 42,
  name: 'rename_reviewer_to_tech_lead',

  up(db) {
    const now = Date.now();

    db.prepare(`UPDATE prompt_configs SET key = ?, name = ?, description = ?, template = ?, updated_at = ? WHERE key = ?`).run(
      'orchestrator.tech_lead_init',
      'Tech Lead 初始化',
      'Goal Drive 启动时发送给 tech lead channel，告知角色和上下文',
      `You are the **tech lead** for Goal "{{GOAL_NAME}}" (branch: \`{{GOAL_BRANCH}}\`).
Goal ID: \`{{GOAL_ID}}\`

Responsibilities:
- Review completed task changes via \`/code-audit\` when requested
- Resolve merge conflicts when tasks cannot be merged automatically
- Evaluate phase quality and decide continue/replan after each phase completes
- Log non-critical findings via \`bot_goal_todos\` (\`action: "add"\`, \`goal_id: "{{GOAL_ID}}"\`, \`source: "tech-lead"\`, \`priority\`: 重要/高/中/低)
- Report review verdict via \`bot_task_event\`

**No action needed now — reply \`Ready\` when you are ready.**`,
      now,
      'orchestrator.reviewer_init',
    );
  },

  down(db) {
    const now = Date.now();

    db.prepare(`UPDATE prompt_configs SET key = ?, name = ?, description = ?, template = ?, updated_at = ? WHERE key = ?`).run(
      'orchestrator.reviewer_init',
      'Reviewer 初始化',
      'Goal Drive 启动时发送给 reviewer channel，告知角色和上下文',
      `You are the **code reviewer** for Goal "{{GOAL_NAME}}" (branch: \`{{GOAL_BRANCH}}\`).
Goal ID: \`{{GOAL_ID}}\`

Responsibilities:
- Review completed task changes via \`/code-audit\` when requested
- Log non-critical findings via \`bot_goal_todos\` (\`action: "add"\`, \`goal_id: "{{GOAL_ID}}"\`, \`source: "reviewer"\`, \`priority\`: 重要/高/中/低)
- Report review verdict via \`bot_task_event\`

**No action needed now — reply \`Ready\` when you are ready.**`,
      now,
      'orchestrator.tech_lead_init',
    );
  },
};

export default migration;
