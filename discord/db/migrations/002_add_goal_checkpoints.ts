import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 2,
  name: 'add_goal_checkpoints',

  up(db) {
    db.exec(`
      -- ============================================================
      -- goal_checkpoints 表 — 记录 Goal 关键节点快照
      -- ============================================================
      CREATE TABLE goal_checkpoints (
        id                TEXT PRIMARY KEY,
        goal_id           TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        trigger           TEXT NOT NULL,
        trigger_task_id   TEXT,
        reason            TEXT,
        tasks_snapshot    TEXT,
        git_ref           TEXT,
        change_summary    TEXT,
        created_at        INTEGER NOT NULL
      );

      CREATE INDEX idx_goal_checkpoints_goal
        ON goal_checkpoints(goal_id, created_at);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_goal_checkpoints_goal;
      DROP TABLE IF EXISTS goal_checkpoints;
    `);
  },
};

export default migration;
