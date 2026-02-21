import type { Migration } from '../migrate.js';

/**
 * 创建 goal_timeline 表
 *
 * 记录 Goal drive 过程中的关键事件（启动、暂停、任务派发/完成/失败、重规划等），
 * 供 Web 端以 Timeline 形式展示。
 */

const migration: Migration = {
  version: 32,
  name: 'create_goal_timeline',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goal_timeline (
        id          TEXT PRIMARY KEY,
        goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        type        TEXT NOT NULL DEFAULT 'info',
        message     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goal_timeline_goal
        ON goal_timeline(goal_id, created_at);
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS goal_timeline;`);
  },
};

export default migration;
