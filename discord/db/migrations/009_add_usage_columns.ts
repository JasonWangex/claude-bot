import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 9,
  name: 'add_usage_columns',

  up(db) {
    db.exec(`
      ALTER TABLE goal_tasks ADD COLUMN tokens_in INTEGER;
      ALTER TABLE goal_tasks ADD COLUMN tokens_out INTEGER;
      ALTER TABLE goal_tasks ADD COLUMN cache_read_in INTEGER;
      ALTER TABLE goal_tasks ADD COLUMN cache_write_in INTEGER;
      ALTER TABLE goal_tasks ADD COLUMN cost_usd REAL;
      ALTER TABLE goal_tasks ADD COLUMN duration_ms INTEGER;
    `);
  },

  down(db) {
    // SQLite < 3.35 不支持 DROP COLUMN，用 rebuild 方式
    db.exec(`
      CREATE TABLE goal_tasks_backup AS
        SELECT id, goal_id, description, type, phase, status,
               branch_name, thread_id, dispatched_at, completed_at,
               error, merged, notified_blocked, feedback_json,
               complexity, pipeline_phase, audit_retries
        FROM goal_tasks;

      DROP TABLE goal_tasks;

      CREATE TABLE goal_tasks (
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
        complexity      TEXT,
        pipeline_phase  TEXT,
        audit_retries   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (goal_id, id)
      );

      INSERT INTO goal_tasks
        SELECT * FROM goal_tasks_backup;

      DROP TABLE goal_tasks_backup;
    `);
  },
};

export default migration;
