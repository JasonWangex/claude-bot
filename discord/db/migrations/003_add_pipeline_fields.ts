import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 3,
  name: 'add_pipeline_fields',

  up(db) {
    db.exec(`
      ALTER TABLE goal_tasks ADD COLUMN complexity TEXT;
      ALTER TABLE goal_tasks ADD COLUMN pipeline_phase TEXT;
      ALTER TABLE goal_tasks ADD COLUMN audit_retries INTEGER NOT NULL DEFAULT 0;
    `);
  },

  down(db) {
    // SQLite 不支持 DROP COLUMN（3.35.0 之前），需重建表保留约束
    db.exec(`
      CREATE TABLE goal_tasks_new (
        id              TEXT NOT NULL,
        goal_id         TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        description     TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT '代码',
        phase           INTEGER,
        status          TEXT NOT NULL DEFAULT 'pending',
        branch_name     TEXT,
        thread_id       TEXT,
        dispatched_at   INTEGER,
        completed_at    INTEGER,
        error           TEXT,
        merged          INTEGER NOT NULL DEFAULT 0,
        notified_blocked INTEGER NOT NULL DEFAULT 0,
        feedback_json   TEXT,
        PRIMARY KEY (goal_id, id)
      );

      INSERT INTO goal_tasks_new
        SELECT id, goal_id, description, type, phase, status,
               branch_name, thread_id, dispatched_at, completed_at,
               error, merged, notified_blocked, feedback_json
        FROM goal_tasks;

      DROP TABLE goal_tasks;
      ALTER TABLE goal_tasks_new RENAME TO goal_tasks;

      CREATE INDEX IF NOT EXISTS idx_goal_tasks_status
        ON goal_tasks(goal_id, status);
      CREATE INDEX IF NOT EXISTS idx_goal_tasks_thread
        ON goal_tasks(thread_id);
    `);
  },
};

export default migration;
