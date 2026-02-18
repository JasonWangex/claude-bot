import type { Migration } from '../migrate.js';

/**
 * Migration 006: channel_session_links 增强
 *
 * 1. 新增 last_message_discord_id 字段（reply 路由用）
 * 2. 新增复合索引 (channel_id, unlinked_at) 避免全表扫描
 */
const migration: Migration = {
  version: 6,
  name: 'channel_session_links_enhance',

  up(db) {
    db.exec(`
      -- 新增 reply 路由字段：记录该 link 最近一次发出的 Discord 消息 ID
      ALTER TABLE channel_session_links
        ADD COLUMN last_message_discord_id TEXT;

      -- 复合索引：按 channel 查活跃 link（WHERE channel_id = ? AND unlinked_at IS NULL）
      CREATE INDEX IF NOT EXISTS idx_csl_channel_active
        ON channel_session_links(channel_id, unlinked_at);

      -- 按 discord 消息 ID 反查 link（reply 路由）
      CREATE INDEX IF NOT EXISTS idx_csl_last_message
        ON channel_session_links(last_message_discord_id)
        WHERE last_message_discord_id IS NOT NULL;
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_csl_last_message;
      DROP INDEX IF EXISTS idx_csl_channel_active;
      -- SQLite 不支持 DROP COLUMN，降级只能重建表
      DROP TABLE IF EXISTS channel_session_links_backup;
      CREATE TABLE channel_session_links_backup AS
        SELECT channel_id, claude_session_id, linked_at, unlinked_at
        FROM channel_session_links;
      DROP TABLE channel_session_links;
      ALTER TABLE channel_session_links_backup RENAME TO channel_session_links;
      CREATE INDEX IF NOT EXISTS idx_csl_channel ON channel_session_links(channel_id);
      CREATE INDEX IF NOT EXISTS idx_csl_session ON channel_session_links(claude_session_id);
    `);
  },
};

export default migration;
