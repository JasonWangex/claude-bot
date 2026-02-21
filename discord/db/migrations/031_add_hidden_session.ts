import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions 表添加 hidden 列；为 tasks 表添加 audit_session_key 列。
 *
 * claude_sessions.hidden = 1 的 session 是内部 audit session（无对应 Discord channel），
 * 不在 web UI sessions 列表中展示。
 *
 * tasks.audit_session_key 存储每个子任务对应的 hidden audit session 的虚拟 channelId
 * （格式：'audit-{taskId}'），持久化后重启可恢复。
 */

const migration: Migration = {
  version: 31,
  name: 'add_hidden_session',

  up(db) {
    // 旧行 hidden 默认 0，不影响现有 session
    db.exec(`ALTER TABLE claude_sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
    // 旧行 audit_session_key 默认 NULL
    db.exec(`ALTER TABLE tasks ADD COLUMN audit_session_key TEXT`);
  },

  down(_db) {
    // SQLite 不支持 DROP COLUMN（旧版本），无法回滚
  },
};

export default migration;
