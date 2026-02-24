import type { Migration } from '../migrate.js';

/**
 * 创建 session_changes 表。
 *
 * 每次 bot session 完成后，将 FileChange[] 以 JSON 存入此表，
 * 取代原先生成 HTML 并上传 OSS/Discord 附件的方式。
 * Web 端直接读取原始数据并在浏览器内渲染 diff。
 */
const migration: Migration = {
  version: 39,
  name: 'create_session_changes',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_changes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id   TEXT    NOT NULL,
        file_changes TEXT    NOT NULL,  -- JSON array of FileChange
        file_count   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_changes_channel
        ON session_changes(channel_id, created_at DESC)
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS session_changes`);
  },
};

export default migration;
