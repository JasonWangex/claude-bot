import type { Migration } from '../migrate.js';

/**
 * 清理 orchestrator.task.dependencies prompt
 *
 * 该 prompt 用于展示任务的前置依赖列表，随 depends 机制一起移除。
 * 现在任务依赖通过 phase 顺序表达，不再需要显式的依赖列表。
 */
const migration: Migration = {
  version: 19,
  name: 'cleanup_task_dep_prompt',

  up(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`)
      .run('orchestrator.task.dependencies');
  },

  down(_db) {
    // 不可逆：prompt 数据已从 seed 中移除
  },
};

export default migration;
