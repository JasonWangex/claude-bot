import type { Migration } from '../migrate.js';

/**
 * 迁移 010: 添加按模型分槽的 session 管理字段
 * - session_ids_json: {sonnet?: string, opus?: string}
 * - prev_session_ids_json: {sonnet?: string, opus?: string} (用于 rewind)
 */
const migration: Migration = {
  version: 10,
  name: 'add_session_slots',

  up(db) {
    db.exec(`
      -- 为 sessions 表添加模型槽字段
      ALTER TABLE sessions ADD COLUMN session_ids_json TEXT;
      ALTER TABLE sessions ADD COLUMN prev_session_ids_json TEXT;

      -- 为 archived_sessions 表添加模型槽字段
      ALTER TABLE archived_sessions ADD COLUMN session_ids_json TEXT;
      ALTER TABLE archived_sessions ADD COLUMN prev_session_ids_json TEXT;
    `);
  },

  down(db) {
    // SQLite 不支持 DROP COLUMN，需要重建表（降级操作通常不需要）
    // 为简化实现，这里不实现降级逻辑
    throw new Error('Downgrade from migration 010 is not supported');
  },
};

export default migration;
