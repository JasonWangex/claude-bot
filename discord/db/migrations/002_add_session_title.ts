import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions 表添加 title 列
 *
 * title 由 DeepSeek LLM 根据第一条用户消息自动生成。
 */
const migration: Migration = {
  version: 2,
  name: 'add_session_title',

  up(db) {
    db.exec(`ALTER TABLE claude_sessions ADD COLUMN title TEXT;`);
  },

  down(db) {
    // SQLite 不支持 DROP COLUMN（3.35+ 支持但为安全起见用重建）
    db.exec(`
      CREATE TABLE claude_sessions_backup AS SELECT
        id, claude_session_id, prev_claude_session_id, channel_id, model,
        plan_mode, status, created_at, closed_at, purpose, parent_session_id,
        last_activity_at, last_usage_json, last_stop_at
      FROM claude_sessions;
      DROP TABLE claude_sessions;
      ALTER TABLE claude_sessions_backup RENAME TO claude_sessions;
    `);
  },
};

export default migration;
