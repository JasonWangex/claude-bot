import type { Migration } from '../migrate.js';

/**
 * 清理重构后不再使用的 prompt configs
 *
 * 移除的 prompt：
 * - Brain 相关：brain_init, brain_post_eval, brain_failure, brain_replan
 * - Pipeline 相关：plan + sections, execute_with_plan + sections, audit + sections,
 *   fix + sections, self_review, feedback_investigation, task_readiness_check.*
 *
 * 新增的 prompt 通过 seed 自动插入（INSERT OR IGNORE）。
 */
const migration: Migration = {
  version: 17,
  name: 'cleanup_old_prompts',

  up(db) {
    const del = db.prepare(`DELETE FROM prompt_configs WHERE key = ?`);

    const keysToDelete = [
      // Brain prompts
      'orchestrator.brain_init',
      'orchestrator.brain_post_eval',
      'orchestrator.brain_failure',
      'orchestrator.brain_replan',

      // Plan pipeline
      'orchestrator.plan',
      'orchestrator.plan.detail_plan',
      'orchestrator.plan.dependencies',
      'orchestrator.plan.rules',

      // Execute with plan pipeline
      'orchestrator.execute_with_plan',
      'orchestrator.execute_with_plan.detail_plan',
      'orchestrator.execute_with_plan.dependencies',
      'orchestrator.execute_with_plan.rules',

      // Audit pipeline
      'orchestrator.audit',
      'orchestrator.audit.context',
      'orchestrator.audit.scope_rules',
      'orchestrator.audit.output_format',

      // Fix pipeline
      'orchestrator.fix',
      'orchestrator.fix.context',
      'orchestrator.fix.rules',
      'orchestrator.fix.verify',
      'orchestrator.fix.verify_section',
      'orchestrator.fix.verify_fallback',
      'orchestrator.fix.critical_rules',

      // Self-review
      'orchestrator.self_review',

      // Feedback investigation
      'orchestrator.feedback_investigation',

      // Task readiness check
      'orchestrator.task_readiness_check.execute',
      'orchestrator.task_readiness_check.audit',

      // Merged into feedback_protocol
      'orchestrator.task.when_to_feedback',
    ];

    const deleteAll = db.transaction(() => {
      for (const key of keysToDelete) {
        del.run(key);
      }
    });
    deleteAll();
  },

  down(_db) {
    // 不可逆：旧 prompt 数据已删除
    // 重新运行 seed 即可恢复（如果需要）
  },
};

export default migration;
