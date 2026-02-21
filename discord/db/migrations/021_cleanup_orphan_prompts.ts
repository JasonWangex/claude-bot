import type { Migration } from '../migrate.js';

/**
 * 清理数据库中无代码引用的孤立 prompt 条目
 *
 * 这些 key 来自 Pipeline 多阶段重构前的历史遗留（plan/execute_with_plan/audit/fix），
 * 已不在当前 prompt-requirements.ts 中，也不在 seed 中，属于僵尸数据。
 *
 * 移除的 key：
 * - orchestrator.audit.detail_plan
 * - orchestrator.audit.instructions
 * - orchestrator.execute_with_plan.instructions
 * - orchestrator.fix.audit_summary
 * - orchestrator.fix.detail_plan
 * - orchestrator.fix.instructions
 * - orchestrator.plan.instructions
 */
const migration: Migration = {
  version: 21,
  name: 'cleanup_orphan_prompts',

  up(db) {
    const keys = [
      'orchestrator.audit.detail_plan',
      'orchestrator.audit.instructions',
      'orchestrator.execute_with_plan.instructions',
      'orchestrator.fix.audit_summary',
      'orchestrator.fix.detail_plan',
      'orchestrator.fix.instructions',
      'orchestrator.plan.instructions',
    ];

    const del = db.prepare(`DELETE FROM prompt_configs WHERE key = ?`);
    db.transaction(() => {
      for (const key of keys) {
        del.run(key);
      }
    })();
  },

  down(_db) {
    // 不可逆：历史 prompt 数据已从代码中移除，无法恢复
  },
};

export default migration;
