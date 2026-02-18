import type { Migration } from '../migrate.js';
import { seedPromptConfigs } from '../seeds/prompt-seeds.js';

/**
 * 初始 Schema 创建
 *
 * 此文件由原 001-013 共 13 个 migration 合并而来（项目正式上线前一次性合并）。
 * 包含所有当前有效的表，已废弃的历史表（sessions, archived_sessions,
 * message_history, goal_tasks 等）不再创建。
 */
const migration: Migration = {
  version: 1,
  name: 'create_schema',

  up(db) {
    db.exec(`
      -- ============================================================
      -- guilds 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS guilds (
        guild_id      TEXT PRIMARY KEY,
        default_cwd   TEXT NOT NULL,
        default_model TEXT,
        last_activity INTEGER NOT NULL
      );

      -- ============================================================
      -- goals 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS goals (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'Pending',
        type                  TEXT,
        project               TEXT,
        date                  TEXT,
        completion            TEXT,
        progress              TEXT,
        next                  TEXT,
        blocked_by            TEXT,
        body                  TEXT,
        drive_status          TEXT,
        drive_branch          TEXT,
        drive_thread_id       TEXT,
        drive_base_cwd        TEXT,
        drive_max_concurrent  INTEGER,
        drive_created_at      INTEGER,
        drive_updated_at      INTEGER,
        drive_pending_json    TEXT,
        seq                   INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_goals_drive_status ON goals(drive_status);

      -- ============================================================
      -- goal_checkpoints 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS goal_checkpoints (
        id                TEXT PRIMARY KEY,
        goal_id           TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        trigger           TEXT NOT NULL,
        trigger_task_id   TEXT,
        reason            TEXT,
        tasks_snapshot    TEXT,
        git_ref           TEXT,
        change_summary    TEXT,
        created_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_goal
        ON goal_checkpoints(goal_id, created_at);

      -- ============================================================
      -- channels 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS channels (
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

      CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
      CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);
      CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id);

      -- ============================================================
      -- claude_sessions 表 (替代原混合 session 概念)
      -- ============================================================
      CREATE TABLE IF NOT EXISTS claude_sessions (
        id                      TEXT PRIMARY KEY,    -- 本地 UUID
        claude_session_id       TEXT,                -- Claude CLI session_id
        prev_claude_session_id  TEXT,                -- 上一轮（rewind 用）
        channel_id              TEXT REFERENCES channels(id),
        model                   TEXT,
        plan_mode               INTEGER NOT NULL DEFAULT 0,
        status                  TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'waiting' | 'idle' | 'closed'
        created_at              INTEGER NOT NULL,
        closed_at               INTEGER,
        purpose                 TEXT,                -- 'channel' | 'plan' | 'temp' | 'replan'
        parent_session_id       TEXT REFERENCES claude_sessions(id),
        last_activity_at        INTEGER,             -- 最后一次活动时间（超时监控用）
        last_usage_json         TEXT,                -- 最后一次 token/cost 数据
        last_stop_at            INTEGER              -- 最后一次 Stop 事件时间（幂等窗口用）
      );

      CREATE INDEX IF NOT EXISTS idx_claude_sessions_channel
        ON claude_sessions(channel_id);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_claude_id
        ON claude_sessions(claude_session_id);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_status
        ON claude_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_purpose
        ON claude_sessions(purpose);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_parent
        ON claude_sessions(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_status_activity
        ON claude_sessions(status, last_activity_at);

      -- ============================================================
      -- channel_session_links 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS channel_session_links (
        channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        claude_session_id TEXT NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
        linked_at         INTEGER NOT NULL,
        unlinked_at       INTEGER,
        PRIMARY KEY (channel_id, claude_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_csl_channel ON channel_session_links(channel_id);
      CREATE INDEX IF NOT EXISTS idx_csl_session ON channel_session_links(claude_session_id);

      -- ============================================================
      -- sync_cursors 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS sync_cursors (
        source      TEXT PRIMARY KEY,     -- 数据源标识
        cursor      TEXT NOT NULL,        -- 同步游标值（时间戳、ID 等）
        updated_at  INTEGER NOT NULL
      );

      -- ============================================================
      -- tasks 表 (替代原 goal_tasks，goal_id 改为 nullable)
      -- ============================================================
      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT NOT NULL PRIMARY KEY,  -- 全局唯一 ID
        goal_id          TEXT REFERENCES goals(id) ON DELETE CASCADE,  -- nullable
        description      TEXT NOT NULL,
        type             TEXT NOT NULL DEFAULT '代码',
        phase            INTEGER,
        status           TEXT NOT NULL DEFAULT 'pending',
        branch_name      TEXT,
        channel_id       TEXT REFERENCES channels(id),
        dispatched_at    INTEGER,
        completed_at     INTEGER,
        error            TEXT,
        merged           INTEGER NOT NULL DEFAULT 0,
        notified_blocked INTEGER NOT NULL DEFAULT 0,
        feedback_json    TEXT,
        complexity       TEXT,
        pipeline_phase   TEXT,
        audit_retries    INTEGER NOT NULL DEFAULT 0,
        tokens_in        INTEGER,
        tokens_out       INTEGER,
        cache_read_in    INTEGER,
        cache_write_in   INTEGER,
        cost_usd         REAL,
        duration_ms      INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(goal_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);

      -- ============================================================
      -- task_deps 表 (替代原 goal_task_deps)
      -- ============================================================
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        goal_id             TEXT,        -- 保留 goal_id 方便查询
        PRIMARY KEY (task_id, depends_on_task_id)
      );

      -- ============================================================
      -- devlogs 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS devlogs (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        date          TEXT NOT NULL,
        project       TEXT NOT NULL,
        branch        TEXT,
        summary       TEXT,
        commits       INTEGER,
        lines_changed TEXT,
        goal          TEXT,
        body          TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devlogs_project ON devlogs(project);
      CREATE INDEX IF NOT EXISTS idx_devlogs_date ON devlogs(date);

      -- ============================================================
      -- ideas 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS ideas (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'Idea',
        project     TEXT NOT NULL,
        date        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
      CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project);

      -- ============================================================
      -- knowledge_base 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        category    TEXT,
        tags        TEXT,
        project     TEXT NOT NULL,
        source      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_project ON knowledge_base(project);
      CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);

      -- ============================================================
      -- prompt_configs 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS prompt_configs (
        key             TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        template        TEXT NOT NULL,
        variables       TEXT NOT NULL DEFAULT '[]',
        parent_key      TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_configs_category
        ON prompt_configs(category);
      CREATE INDEX IF NOT EXISTS idx_prompt_configs_parent
        ON prompt_configs(parent_key);
    `);

    // 写入 prompt 种子数据
    seedPromptConfigs(db);
  },

  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS task_deps;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS channel_session_links;
      DROP TABLE IF EXISTS claude_sessions;
      DROP TABLE IF EXISTS channels;
      DROP TABLE IF EXISTS sync_cursors;
      DROP TABLE IF EXISTS goal_checkpoints;
      DROP TABLE IF EXISTS goals;
      DROP TABLE IF EXISTS guilds;
      DROP TABLE IF EXISTS devlogs;
      DROP TABLE IF EXISTS ideas;
      DROP TABLE IF EXISTS knowledge_base;
      DROP TABLE IF EXISTS prompt_configs;
    `);
  },
};

export default migration;
