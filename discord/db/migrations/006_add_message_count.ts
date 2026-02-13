import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 6,
  name: 'add_message_count',

  up(db) {
    db.exec(`
      -- 在 sessions 表添加 message_count 字段
      ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;

      -- 在 archived_sessions 表添加 message_count 字段
      ALTER TABLE archived_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;

      -- 初始化现有记录的 message_count（从 message_history 计算）
      UPDATE sessions SET message_count = (
        SELECT COUNT(*) FROM message_history WHERE message_history.session_id = sessions.id
      );

      -- archived_sessions 的 message_count 从 message_history_json 无法直接计算，
      -- 保持为 0（历史数据不重要）
    `);
  },

  down(db) {
    db.exec(`
      -- SQLite 不支持 DROP COLUMN，需要重建表
      -- 由于这是新增字段，回滚时简单删除即可（仅测试环境使用）

      -- sessions 表回滚（重建表）
      CREATE TABLE sessions_backup AS SELECT
        id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
        cwd, created_at, last_message, last_message_at, plan_mode, model,
        parent_thread_id, worktree_branch
      FROM sessions;

      DROP TABLE sessions;

      CREATE TABLE sessions (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL DEFAULT '',
        thread_id       TEXT NOT NULL,
        guild_id        TEXT NOT NULL,
        claude_session_id TEXT,
        prev_claude_session_id TEXT,
        cwd             TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        last_message     TEXT,
        last_message_at  INTEGER,
        plan_mode       INTEGER NOT NULL DEFAULT 0,
        model           TEXT,
        parent_thread_id TEXT,
        worktree_branch  TEXT,
        UNIQUE(guild_id, thread_id)
      );

      INSERT INTO sessions SELECT * FROM sessions_backup;
      DROP TABLE sessions_backup;

      CREATE INDEX IF NOT EXISTS idx_sessions_guild_thread
        ON sessions(guild_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_claude_session
        ON sessions(guild_id, claude_session_id);

      -- archived_sessions 表回滚（重建表）
      CREATE TABLE archived_sessions_backup AS SELECT
        id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
        cwd, created_at, last_message, last_message_at, plan_mode, model,
        parent_thread_id, worktree_branch, archived_at, archived_by, archive_reason,
        message_history_json
      FROM archived_sessions;

      DROP TABLE archived_sessions;

      CREATE TABLE archived_sessions (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL DEFAULT '',
        thread_id       TEXT NOT NULL,
        guild_id        TEXT NOT NULL,
        claude_session_id TEXT,
        prev_claude_session_id TEXT,
        cwd             TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        last_message     TEXT,
        last_message_at  INTEGER,
        plan_mode       INTEGER NOT NULL DEFAULT 0,
        model           TEXT,
        parent_thread_id TEXT,
        worktree_branch  TEXT,
        archived_at     INTEGER NOT NULL,
        archived_by     TEXT,
        archive_reason  TEXT,
        message_history_json TEXT
      );

      INSERT INTO archived_sessions SELECT * FROM archived_sessions_backup;
      DROP TABLE archived_sessions_backup;

      CREATE INDEX IF NOT EXISTS idx_archived_sessions_guild_thread
        ON archived_sessions(guild_id, thread_id);
    `);
  },
};

export default migration;
