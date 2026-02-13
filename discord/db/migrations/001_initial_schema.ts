import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 1,
  name: 'initial_schema',

  up(db) {
    db.exec(`
      -- ============================================================
      -- sessions 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS sessions (
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

      CREATE INDEX IF NOT EXISTS idx_sessions_guild_thread
        ON sessions(guild_id, thread_id);

      CREATE INDEX IF NOT EXISTS idx_sessions_claude_session
        ON sessions(guild_id, claude_session_id);

      -- ============================================================
      -- message_history 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS message_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text        TEXT NOT NULL,
        timestamp   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_message_history_session
        ON message_history(session_id, timestamp);

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
      -- archived_sessions 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS archived_sessions (
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

      CREATE INDEX IF NOT EXISTS idx_archived_sessions_guild_thread
        ON archived_sessions(guild_id, thread_id);

      -- ============================================================
      -- goals 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS goals (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'Active',
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
        drive_updated_at      INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_goals_status
        ON goals(status);

      CREATE INDEX IF NOT EXISTS idx_goals_drive_status
        ON goals(drive_status);

      -- ============================================================
      -- goal_tasks 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS goal_tasks (
        id              TEXT NOT NULL,
        goal_id         TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        description     TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT '代码',
        phase           INTEGER,
        status          TEXT NOT NULL DEFAULT 'pending',
        branch_name     TEXT,
        thread_id       TEXT,
        dispatched_at   INTEGER,
        completed_at    INTEGER,
        error           TEXT,
        merged          INTEGER NOT NULL DEFAULT 0,
        notified_blocked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (goal_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_tasks_status
        ON goal_tasks(goal_id, status);

      CREATE INDEX IF NOT EXISTS idx_goal_tasks_thread
        ON goal_tasks(thread_id);

      -- ============================================================
      -- goal_task_deps 表
      -- ============================================================
      CREATE TABLE IF NOT EXISTS goal_task_deps (
        task_id             TEXT NOT NULL,
        goal_id             TEXT NOT NULL,
        depends_on_task_id  TEXT NOT NULL,
        PRIMARY KEY (goal_id, task_id, depends_on_task_id),
        FOREIGN KEY (goal_id, task_id) REFERENCES goal_tasks(goal_id, id) ON DELETE CASCADE,
        FOREIGN KEY (goal_id, depends_on_task_id) REFERENCES goal_tasks(goal_id, id) ON DELETE CASCADE
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

      CREATE INDEX IF NOT EXISTS idx_devlogs_project
        ON devlogs(project);

      CREATE INDEX IF NOT EXISTS idx_devlogs_date
        ON devlogs(date);

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

      CREATE INDEX IF NOT EXISTS idx_ideas_status
        ON ideas(status);

      CREATE INDEX IF NOT EXISTS idx_ideas_project
        ON ideas(project);
    `);
  },

  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS goal_task_deps;
      DROP TABLE IF EXISTS goal_tasks;
      DROP TABLE IF EXISTS goals;
      DROP TABLE IF EXISTS archived_sessions;
      DROP TABLE IF EXISTS message_history;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS guilds;
      DROP TABLE IF EXISTS devlogs;
      DROP TABLE IF EXISTS ideas;
    `);
  },
};

export default migration;
