import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions.claude_session_id 添加唯一索引
 *
 * 防止同一 claude_session_id 因并发调用而产生重复记录。
 * 使用 partial index（WHERE claude_session_id IS NOT NULL）允许 NULL 值共存。
 */
const migration: Migration = {
  version: 5,
  name: 'unique_claude_session_id',

  up(db) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_sessions_claude_session_id
      ON claude_sessions(claude_session_id)
      WHERE claude_session_id IS NOT NULL;
    `);
  },

  down(db) {
    db.exec(`DROP INDEX IF EXISTS idx_claude_sessions_claude_session_id;`);
  },
};

export default migration;
