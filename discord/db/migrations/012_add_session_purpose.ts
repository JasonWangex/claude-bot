import type { Migration } from '../migrate.js';

/**
 * 增强 claude_sessions 表 - 添加 purpose 和 parent_session_id 字段
 *
 * 目标：追踪所有类型的 Claude session（包括临时、plan mode、replan）
 * - purpose: 会话用途（'channel' | 'plan' | 'temp' | 'replan'）
 * - parent_session_id: 父会话 ID（plan/replan session 使用）
 */
const migration: Migration = {
  version: 12,
  name: 'add_session_purpose',

  up(db) {
    db.exec(`
      -- 添加 purpose 字段（会话用途）
      ALTER TABLE claude_sessions ADD COLUMN purpose TEXT;

      -- 添加 parent_session_id 字段（父会话 ID）
      ALTER TABLE claude_sessions ADD COLUMN parent_session_id TEXT REFERENCES claude_sessions(id);

      -- 创建索引加速按 purpose 查询
      CREATE INDEX idx_claude_sessions_purpose ON claude_sessions(purpose);

      -- 创建索引加速父子关系查询
      CREATE INDEX idx_claude_sessions_parent ON claude_sessions(parent_session_id);

      -- 迁移现有数据：所有现有 session 默认为 'channel' 用途
      UPDATE claude_sessions SET purpose = 'channel' WHERE purpose IS NULL AND channel_id IS NOT NULL;
    `);
  },

  down(db) {
    db.exec(`
      -- SQLite 不支持直接删除列，需要重建表
      -- 创建临时表
      CREATE TABLE claude_sessions_backup (
        id                      TEXT PRIMARY KEY,
        claude_session_id       TEXT,
        prev_claude_session_id  TEXT,
        channel_id              TEXT REFERENCES channels(id),
        model                   TEXT,
        plan_mode               INTEGER NOT NULL DEFAULT 0,
        status                  TEXT NOT NULL DEFAULT 'active',
        created_at              INTEGER NOT NULL,
        closed_at               INTEGER
      );

      -- 复制数据
      INSERT INTO claude_sessions_backup
      SELECT id, claude_session_id, prev_claude_session_id,
             channel_id, model, plan_mode, status, created_at, closed_at
      FROM claude_sessions;

      -- 删除旧表
      DROP TABLE claude_sessions;

      -- 重命名新表
      ALTER TABLE claude_sessions_backup RENAME TO claude_sessions;

      -- 重建索引
      CREATE INDEX idx_claude_sessions_channel ON claude_sessions(channel_id);
      CREATE INDEX idx_claude_sessions_claude_id ON claude_sessions(claude_session_id);
      CREATE INDEX idx_claude_sessions_status ON claude_sessions(status);
    `);
  },
};

export default migration;
