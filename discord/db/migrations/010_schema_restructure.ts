import type { Migration } from '../migrate.js';

/**
 * Schema 重构 - 术语统一
 *
 * 目标：拆分混合实体，将 sessions/thread/channel 概念清晰化
 * - channels: Discord Channel 实体
 * - claude_sessions: Claude CLI 会话实体
 * - channel_session_links: Channel 与 Claude Session 关联表
 * - sync_cursors: 同步游标表
 * - tasks: 从 goal_tasks 重命名，goal_id 改为 nullable
 */
const migration: Migration = {
  version: 10,
  name: 'schema_restructure',

  up(db) {
    db.exec(`
      -- ============================================================
      -- 1.1 创建 channels 表
      -- ============================================================
      CREATE TABLE channels (
        id                TEXT PRIMARY KEY,        -- Discord Channel ID (snowflake)
        guild_id          TEXT NOT NULL,
        name              TEXT NOT NULL DEFAULT '',
        cwd               TEXT NOT NULL,
        worktree_branch   TEXT,
        parent_channel_id TEXT,                    -- 父 Channel（fork 关系）
        status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
        archived_at       INTEGER,
        archived_by       TEXT,
        archive_reason    TEXT,
        message_count     INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        last_message      TEXT,
        last_message_at   INTEGER,
        UNIQUE(guild_id, id)
      );

      CREATE INDEX idx_channels_guild ON channels(guild_id);
      CREATE INDEX idx_channels_status ON channels(status);
      CREATE INDEX idx_channels_parent ON channels(parent_channel_id);

      -- ============================================================
      -- 1.2 创建 claude_sessions 表
      -- ============================================================
      CREATE TABLE claude_sessions (
        id                      TEXT PRIMARY KEY,    -- 本地 UUID
        claude_session_id       TEXT,                -- Claude CLI session_id
        prev_claude_session_id  TEXT,                -- 上一轮（rewind 用）
        channel_id              TEXT REFERENCES channels(id),
        model                   TEXT,
        plan_mode               INTEGER NOT NULL DEFAULT 0,
        status                  TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'closed'
        created_at              INTEGER NOT NULL,
        closed_at               INTEGER
      );

      CREATE INDEX idx_claude_sessions_channel ON claude_sessions(channel_id);
      CREATE INDEX idx_claude_sessions_claude_id ON claude_sessions(claude_session_id);
      CREATE INDEX idx_claude_sessions_status ON claude_sessions(status);

      -- ============================================================
      -- 1.3 创建 channel_session_links 表
      -- ============================================================
      CREATE TABLE channel_session_links (
        channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        claude_session_id TEXT NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
        linked_at         INTEGER NOT NULL,
        unlinked_at       INTEGER,
        PRIMARY KEY (channel_id, claude_session_id)
      );

      CREATE INDEX idx_csl_channel ON channel_session_links(channel_id);
      CREATE INDEX idx_csl_session ON channel_session_links(claude_session_id);

      -- ============================================================
      -- 1.4 创建 sync_cursors 表
      -- ============================================================
      CREATE TABLE sync_cursors (
        source      TEXT PRIMARY KEY,     -- 数据源标识，如 'discord_messages', 'claude_sessions'
        cursor      TEXT NOT NULL,        -- 同步游标值（时间戳、ID 等）
        updated_at  INTEGER NOT NULL
      );

      -- ============================================================
      -- 1.5 重命名 goal_tasks → tasks，goal_id 改为 nullable
      -- ============================================================
      -- SQLite 不支持 RENAME TABLE 保留外键，需要重建

      -- 创建新 tasks 表
      CREATE TABLE tasks (
        id              TEXT NOT NULL PRIMARY KEY,  -- 全局唯一 ID
        goal_id         TEXT REFERENCES goals(id) ON DELETE CASCADE,  -- nullable
        description     TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT '代码',
        phase           INTEGER,
        status          TEXT NOT NULL DEFAULT 'pending',
        branch_name     TEXT,
        channel_id      TEXT REFERENCES channels(id),  -- 替代 thread_id
        dispatched_at   INTEGER,
        completed_at    INTEGER,
        error           TEXT,
        merged          INTEGER NOT NULL DEFAULT 0,
        notified_blocked INTEGER NOT NULL DEFAULT 0,
        feedback_json   TEXT,
        complexity      TEXT,
        pipeline_phase  TEXT,
        audit_retries   INTEGER NOT NULL DEFAULT 0,
        tokens_in       INTEGER,
        tokens_out      INTEGER,
        cache_read_in   INTEGER,
        cache_write_in  INTEGER,
        cost_usd        REAL,
        duration_ms     INTEGER
      );

      CREATE INDEX idx_tasks_goal ON tasks(goal_id);
      CREATE INDEX idx_tasks_status ON tasks(goal_id, status);
      CREATE INDEX idx_tasks_channel ON tasks(channel_id);

      -- 迁移数据（将复合 ID 转为全局唯一 ID）
      INSERT INTO tasks (
        id, goal_id, description, type, phase, status,
        branch_name, channel_id, dispatched_at, completed_at,
        error, merged, notified_blocked, feedback_json,
        complexity, pipeline_phase, audit_retries,
        tokens_in, tokens_out, cache_read_in, cache_write_in,
        cost_usd, duration_ms
      )
      SELECT
        goal_id || ':' || id,       -- 组合为全局唯一 ID
        goal_id, description, type, phase, status,
        branch_name, thread_id,     -- thread_id 暂存到 channel_id
        dispatched_at, completed_at, error, merged, notified_blocked,
        feedback_json, complexity, pipeline_phase, audit_retries,
        tokens_in, tokens_out, cache_read_in, cache_write_in,
        cost_usd, duration_ms
      FROM goal_tasks;

      -- 创建新 task_deps 表
      CREATE TABLE task_deps (
        task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        goal_id             TEXT,        -- 保留 goal_id 方便查询
        PRIMARY KEY (task_id, depends_on_task_id)
      );

      -- 迁移依赖关系（注意 ID 映射）
      INSERT INTO task_deps (task_id, depends_on_task_id, goal_id)
      SELECT
        goal_id || ':' || task_id,
        goal_id || ':' || depends_on_task_id,
        goal_id
      FROM goal_task_deps;

      -- ============================================================
      -- 1.6 数据迁移：sessions → channels + claude_sessions
      -- ============================================================

      -- 从 sessions 迁移到 channels
      INSERT INTO channels (
        id, guild_id, name, cwd, worktree_branch,
        parent_channel_id, status, message_count,
        created_at, last_message, last_message_at
      )
      SELECT
        thread_id, guild_id, name, cwd, worktree_branch,
        parent_thread_id, 'active', message_count,
        created_at, last_message, last_message_at
      FROM sessions;

      -- 从 archived_sessions 迁移到 channels（status = 'archived'）
      INSERT OR IGNORE INTO channels (
        id, guild_id, name, cwd, worktree_branch,
        parent_channel_id, status,
        archived_at, archived_by, archive_reason,
        message_count, created_at,
        last_message, last_message_at
      )
      SELECT
        thread_id, guild_id, name, cwd, worktree_branch,
        parent_thread_id, 'archived',
        archived_at, archived_by, archive_reason,
        message_count, created_at,
        last_message, last_message_at
      FROM archived_sessions;

      -- 从 sessions 迁移到 claude_sessions
      INSERT INTO claude_sessions (
        id, claude_session_id, prev_claude_session_id,
        channel_id, model, plan_mode, status, created_at
      )
      SELECT
        id, claude_session_id, prev_claude_session_id,
        thread_id, model, plan_mode, 'active', created_at
      FROM sessions;

      -- 从 archived_sessions 迁移到 claude_sessions（status = 'closed'）
      INSERT INTO claude_sessions (
        id, claude_session_id, prev_claude_session_id,
        channel_id, model, plan_mode, status,
        created_at, closed_at
      )
      SELECT
        id, claude_session_id, prev_claude_session_id,
        thread_id, model, plan_mode, 'closed',
        created_at, archived_at
      FROM archived_sessions;

      -- 创建 channel_session_links
      INSERT INTO channel_session_links (channel_id, claude_session_id, linked_at)
      SELECT thread_id, id, created_at
      FROM sessions
      WHERE claude_session_id IS NOT NULL;

      INSERT OR IGNORE INTO channel_session_links (
        channel_id, claude_session_id, linked_at, unlinked_at
      )
      SELECT thread_id, id, created_at, archived_at
      FROM archived_sessions
      WHERE claude_session_id IS NOT NULL;

      -- ============================================================
      -- 1.7 废弃旧表（重命名为 _deprecated）
      -- ============================================================

      ALTER TABLE sessions RENAME TO _deprecated_sessions;
      ALTER TABLE archived_sessions RENAME TO _deprecated_archived_sessions;
      ALTER TABLE goal_tasks RENAME TO _deprecated_goal_tasks;
      ALTER TABLE goal_task_deps RENAME TO _deprecated_goal_task_deps;

      -- ============================================================
      -- 1.8 初始化 sync_cursors
      -- ============================================================

      INSERT INTO sync_cursors (source, cursor, updated_at)
      VALUES ('schema_migration_010', 'completed', ${Date.now()});
    `);
  },

  down(db) {
    db.exec(`
      -- 恢复旧表名
      ALTER TABLE _deprecated_sessions RENAME TO sessions;
      ALTER TABLE _deprecated_archived_sessions RENAME TO archived_sessions;
      ALTER TABLE _deprecated_goal_tasks RENAME TO goal_tasks;
      ALTER TABLE _deprecated_goal_task_deps RENAME TO goal_task_deps;

      -- 删除新表
      DROP TABLE IF EXISTS channel_session_links;
      DROP TABLE IF EXISTS claude_sessions;
      DROP TABLE IF EXISTS channels;
      DROP TABLE IF EXISTS task_deps;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS sync_cursors;
    `);
  },
};

export default migration;
