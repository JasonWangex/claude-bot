import type { Migration } from '../migrate.js';

/**
 * 为 Goal 添加待办事项（todo）表
 *
 * 用于记录工作过程中临时发现的问题和提醒，
 * 与 tasks 表（结构化交付任务）互补。
 */
const migration: Migration = {
  version: 14,
  name: 'create_goal_todos',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goal_todos (
        id          TEXT PRIMARY KEY,
        goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        done        INTEGER NOT NULL DEFAULT 0,
        source      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goal_todos_goal_id ON goal_todos(goal_id);
      CREATE INDEX IF NOT EXISTS idx_goal_todos_done ON goal_todos(goal_id, done);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_goal_todos_done;
      DROP INDEX IF EXISTS idx_goal_todos_goal_id;
      DROP TABLE IF EXISTS goal_todos;
    `);
  },
};

export default migration;
