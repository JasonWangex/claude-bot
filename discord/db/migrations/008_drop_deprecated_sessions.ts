import type { Migration } from '../migrate.js';

/**
 * 删除已废弃的 _deprecated_sessions 和 _deprecated_archived_sessions 表
 *
 * 所有数据已统一到 channels + claude_sessions + channel_session_links。
 * 此操作不可逆。
 */
const migration: Migration = {
  version: 8,
  name: 'drop_deprecated_sessions',

  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS _deprecated_archived_sessions;
      DROP TABLE IF EXISTS _deprecated_sessions;
    `);
  },

  down() {
    // 不可逆 — 旧表数据已迁移到新表
  },
};

export default migration;
