import type { Migration } from '../migrate.js';

/**
 * 扩展 claude_sessions 表 - 添加中间状态和活动追踪
 *
 * 目标：精确追踪 Claude session 的生命周期和执行状态
 * - 扩展 status 字段支持更多状态（'active' | 'waiting' | 'idle' | 'closed'）
 * - last_activity_at: 最后一次活动时间（用于超时监控）
 * - last_usage_json: 最后一次执行的 token/cost 数据
 */
const migration: Migration = {
  version: 13,
  name: 'add_session_states',

  up(db) {
    db.exec(`
      -- 添加 last_activity_at 字段（最后活动时间）
      ALTER TABLE claude_sessions ADD COLUMN last_activity_at INTEGER;

      -- 添加 last_usage_json 字段（最后一次 token/cost 数据）
      ALTER TABLE claude_sessions ADD COLUMN last_usage_json TEXT;

      -- 添加 last_stop_at 字段（最后一次 Stop 事件时间，用于幂等窗口）
      ALTER TABLE claude_sessions ADD COLUMN last_stop_at INTEGER;

      -- 创建索引加速按状态和活动时间查询（超时监控用）
      CREATE INDEX idx_claude_sessions_status_activity
        ON claude_sessions(status, last_activity_at);

      -- 迁移现有数据：设置活跃 session 的 last_activity_at 为创建时间
      UPDATE claude_sessions
      SET last_activity_at = created_at
      WHERE last_activity_at IS NULL AND status = 'active';
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
        closed_at               INTEGER,
        purpose                 TEXT,
        parent_session_id       TEXT REFERENCES claude_sessions(id)
      );

      -- 复制数据
      INSERT INTO claude_sessions_backup
      SELECT id, claude_session_id, prev_claude_session_id,
             channel_id, model, plan_mode, status, created_at, closed_at,
             purpose, parent_session_id
      FROM claude_sessions;

      -- 删除旧表
      DROP TABLE claude_sessions;

      -- 重命名新表
      ALTER TABLE claude_sessions_backup RENAME TO claude_sessions;

      -- 重建原有索引
      CREATE INDEX idx_claude_sessions_channel ON claude_sessions(channel_id);
      CREATE INDEX idx_claude_sessions_claude_id ON claude_sessions(claude_session_id);
      CREATE INDEX idx_claude_sessions_status ON claude_sessions(status);
      CREATE INDEX idx_claude_sessions_purpose ON claude_sessions(purpose);
      CREATE INDEX idx_claude_sessions_parent ON claude_sessions(parent_session_id);
    `);
  },
};

export default migration;
