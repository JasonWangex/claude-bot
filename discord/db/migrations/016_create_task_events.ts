import type { Migration } from '../migrate.js';

/**
 * 为 AI → Orchestrator 反向通信创建事件表
 *
 * 替换原有的基于文件系统的 JSON 文件通信方式，
 * 提供可靠、可追溯的事件存储。支持：
 * - feedback.main / audit / self_review / investigate / readiness（Task AI 写入）
 * - brain.eval / failure / replan（Brain AI 写入）
 */
const migration: Migration = {
  version: 16,
  name: 'create_task_events',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id           TEXT PRIMARY KEY,
        goal_id      TEXT REFERENCES goals(id) ON DELETE CASCADE,
        task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_type   TEXT NOT NULL,
        payload      TEXT NOT NULL,
        source       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        processed_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_task_type
        ON task_events(task_id, event_type);

      CREATE INDEX IF NOT EXISTS idx_task_events_pending
        ON task_events(processed_at, created_at);

      CREATE INDEX IF NOT EXISTS idx_task_events_task_id
        ON task_events(task_id);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_task_events_task_id;
      DROP INDEX IF EXISTS idx_task_events_pending;
      DROP INDEX IF EXISTS idx_task_events_task_type;
      DROP TABLE IF EXISTS task_events;
    `);
  },
};

export default migration;
