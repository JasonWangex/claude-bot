import type { Migration } from '../migrate.js';

/**
 * Migration 007: Session PK Refactor
 *
 * claude_sessions PK 从 id(UUID) 改为 claude_session_id(CLI session ID)。
 * channel_session_links FK 直接引用 claude_session_id。
 * 消除 UUID 层，session_id 只来自 Claude CLI。
 *
 * 步骤：
 * 1. 创建 claude_sessions_v2，PK = claude_session_id
 * 2. 迁移数据（只迁移 claude_session_id IS NOT NULL 的行）
 * 3. 创建 channel_session_links_v2，FK → claude_sessions_v2(claude_session_id)
 * 4. 迁移 links（UUID → CLI session ID，INSERT OR IGNORE 处理重复）
 * 5. Drop 旧表，rename _v2 → 原名
 * 6. 重建索引
 */
const migration: Migration = {
  version: 7,
  name: 'session_pk_refactor',

  up(db) {
    // 临时关闭 FK（重建表时需要）
    db.pragma('foreign_keys = OFF');

    db.exec(`
      -- ============================================================
      -- 1. 创建 claude_sessions_v2，PK = claude_session_id
      -- ============================================================
      CREATE TABLE claude_sessions_v2 (
        claude_session_id       TEXT PRIMARY KEY,    -- Claude CLI session_id (PK)
        prev_claude_session_id  TEXT,                -- 上一轮（rewind 用）
        channel_id              TEXT REFERENCES channels(id),
        model                   TEXT,
        plan_mode               INTEGER NOT NULL DEFAULT 0,
        status                  TEXT NOT NULL DEFAULT 'active',
        created_at              INTEGER NOT NULL,
        closed_at               INTEGER,
        purpose                 TEXT,
        parent_session_id       TEXT,                -- 父会话 CLI session_id
        last_activity_at        INTEGER,
        last_usage_json         TEXT,
        last_stop_at            INTEGER,
        title                   TEXT,
        task_id                 TEXT,
        goal_id                 TEXT,
        cwd                     TEXT,
        git_branch              TEXT,
        project_path            TEXT
      );

      -- ============================================================
      -- 2. 迁移数据（只迁移有 claude_session_id 的行）
      --    parent_session_id 通过 self-JOIN 从 UUID 翻译为 CLI session_id
      -- ============================================================
      INSERT INTO claude_sessions_v2 (
        claude_session_id, prev_claude_session_id, channel_id, model,
        plan_mode, status, created_at, closed_at, purpose, parent_session_id,
        last_activity_at, last_usage_json, last_stop_at, title,
        task_id, goal_id, cwd, git_branch, project_path
      )
      SELECT
        cs.claude_session_id,
        cs.prev_claude_session_id,
        cs.channel_id,
        cs.model,
        cs.plan_mode,
        cs.status,
        cs.created_at,
        cs.closed_at,
        cs.purpose,
        parent.claude_session_id,  -- UUID → CLI session_id
        cs.last_activity_at,
        cs.last_usage_json,
        cs.last_stop_at,
        cs.title,
        cs.task_id,
        cs.goal_id,
        cs.cwd,
        cs.git_branch,
        cs.project_path
      FROM claude_sessions cs
      LEFT JOIN claude_sessions parent ON cs.parent_session_id = parent.id
      WHERE cs.claude_session_id IS NOT NULL;

      -- ============================================================
      -- 3. 创建 channel_session_links_v2
      --    FK → claude_sessions_v2(claude_session_id)
      -- ============================================================
      CREATE TABLE channel_session_links_v2 (
        channel_id              TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        claude_session_id       TEXT NOT NULL REFERENCES claude_sessions_v2(claude_session_id) ON DELETE CASCADE,
        linked_at               INTEGER NOT NULL,
        unlinked_at             INTEGER,
        last_message_discord_id TEXT,
        PRIMARY KEY (channel_id, claude_session_id)
      );

      -- ============================================================
      -- 4. 迁移 links（UUID → CLI session_id）
      --    通过 JOIN 将存储的 UUID 翻译为真实 CLI session_id
      --    INSERT OR IGNORE 处理重复（多个 UUID 可能指向同一个 CLI session_id）
      -- ============================================================
      INSERT OR IGNORE INTO channel_session_links_v2 (
        channel_id, claude_session_id, linked_at, unlinked_at, last_message_discord_id
      )
      SELECT
        csl.channel_id,
        cs.claude_session_id,
        csl.linked_at,
        csl.unlinked_at,
        csl.last_message_discord_id
      FROM channel_session_links csl
      JOIN claude_sessions cs ON cs.id = csl.claude_session_id
      WHERE cs.claude_session_id IS NOT NULL;

      -- ============================================================
      -- 5. Drop 旧表，rename _v2 → 原名
      -- ============================================================
      DROP TABLE channel_session_links;
      DROP TABLE claude_sessions;

      ALTER TABLE claude_sessions_v2 RENAME TO claude_sessions;
      ALTER TABLE channel_session_links_v2 RENAME TO channel_session_links;

      -- ============================================================
      -- 6. 重建索引
      --    注意：migration 005 的 UNIQUE index 不再需要（PK 已保证唯一性）
      -- ============================================================
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_channel
        ON claude_sessions(channel_id);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_status
        ON claude_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_purpose
        ON claude_sessions(purpose);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_parent
        ON claude_sessions(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_claude_sessions_status_activity
        ON claude_sessions(status, last_activity_at);

      CREATE INDEX IF NOT EXISTS idx_csl_channel_active
        ON channel_session_links(channel_id, unlinked_at);
      CREATE INDEX IF NOT EXISTS idx_csl_last_message
        ON channel_session_links(last_message_discord_id)
        WHERE last_message_discord_id IS NOT NULL;
    `);

    // 重新开启 FK
    db.pragma('foreign_keys = ON');
  },

  down(db) {
    // 反向操作：恢复 UUID PK 结构
    // 由于 UUID 信息已丢失，down 操作会创建空表结构
    db.pragma('foreign_keys = OFF');

    db.exec(`
      DROP TABLE IF EXISTS channel_session_links;
      DROP TABLE IF EXISTS claude_sessions;

      CREATE TABLE claude_sessions (
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
        parent_session_id       TEXT REFERENCES claude_sessions(id),
        last_activity_at        INTEGER,
        last_usage_json         TEXT,
        last_stop_at            INTEGER,
        title                   TEXT,
        task_id                 TEXT,
        goal_id                 TEXT,
        cwd                     TEXT,
        git_branch              TEXT,
        project_path            TEXT
      );

      CREATE TABLE channel_session_links (
        channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        claude_session_id TEXT NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
        linked_at         INTEGER NOT NULL,
        unlinked_at       INTEGER,
        last_message_discord_id TEXT,
        PRIMARY KEY (channel_id, claude_session_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_sessions_claude_session_id
        ON claude_sessions(claude_session_id)
        WHERE claude_session_id IS NOT NULL;
    `);

    db.pragma('foreign_keys = ON');
  },
};

export default migration;
