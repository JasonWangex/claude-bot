import type { Migration } from '../migrate.js';

/**
 * Migration 036: tasks 表新增 metadata_json 列
 *
 * 用途：
 * - 存储运行时扩展字段（如 lastReviewIssues），避免在-memory数据因重启丢失
 * - 同时将 goal-repo save() 从 delete+reinsert 改为 upsert+删孤儿，
 *   彻底解决 saveState 级联删除 task_events 的问题（在 goal-repo.ts 中生效）
 */
const migration: Migration = {
  version: 36,
  name: 'add_task_metadata',

  up(db) {
    db.prepare(`ALTER TABLE tasks ADD COLUMN metadata_json TEXT`).run();
  },

  down(db) {
    // SQLite 不支持 DROP COLUMN（旧版），仅标记为 no-op
    // 若需回滚需重建表
    void db;
  },
};

export default migration;
