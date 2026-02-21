import type { Migration } from '../migrate.js';

/**
 * Goal 级别事件表
 *
 * 与 task_events 不同，goal_events 不依赖 tasks 表的外键，
 * 用于 Claude skill → Orchestrator 的 goal 级别信号（如 goal.drive）。
 *
 * UNIQUE(goal_id, event_type) 保证每个 goal 同一类型只有一条待处理事件。
 */
const migration: Migration = {
  version: 35,
  name: 'create_goal_events',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goal_events (
        id           TEXT PRIMARY KEY,
        goal_id      TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        payload      TEXT NOT NULL DEFAULT '{}',
        source       TEXT NOT NULL DEFAULT 'ai',
        created_at   INTEGER NOT NULL,
        processed_at INTEGER,
        UNIQUE(goal_id, event_type)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_events_pending
        ON goal_events(processed_at, created_at);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_goal_events_pending;
      DROP TABLE IF EXISTS goal_events;
    `);
  },
};

export default migration;
