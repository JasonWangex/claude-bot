import type { Migration } from '../migrate.js';

/**
 * 为 channels 表添加 hidden 列。
 *
 * channels.hidden = 1 的记录是内部虚拟 channel（如 audit session 使用的 "audit-{taskId}"），
 * 无对应 Discord channel，仅用于满足 claude_sessions.channel_id 的 FK 约束。
 * UI 列表应过滤 hidden = 0 的记录。
 */
const migration: Migration = {
  version: 38,
  name: 'add_hidden_channel',

  up(db) {
    db.exec(`ALTER TABLE channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_hidden ON channels(hidden)`);
  },

  down(_db) {
    // SQLite 不支持 DROP COLUMN（旧版本），无法回滚
  },
};

export default migration;
