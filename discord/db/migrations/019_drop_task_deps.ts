import type { Migration } from '../migrate.js';

/**
 * 删除 task_deps 表
 *
 * Goal 任务顺序改为完全基于 phase 字段控制，
 * 不再使用显式的任务依赖关系（depends/task_deps）。
 */
const migration: Migration = {
  version: 19,
  name: 'drop_task_deps',

  up(db) {
    db.prepare(`DROP TABLE IF EXISTS task_deps`).run();
  },

  down(db) {
    // 恢复 task_deps 表结构（不恢复数据）
    db.prepare(`
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        goal_id TEXT,
        PRIMARY KEY (task_id, depends_on_task_id)
      )
    `).run();
  },
};

export default migration;
