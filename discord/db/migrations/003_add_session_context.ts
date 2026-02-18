import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions 表添加 context 关联字段
 *
 * 新增 task_id, goal_id, cwd, git_branch 四列，
 * 并利用 tasks + channels 表回填已有数据。
 */
const migration: Migration = {
  version: 3,
  name: 'add_session_context',

  up(db) {
    // 加列
    db.exec(`
      ALTER TABLE claude_sessions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
      ALTER TABLE claude_sessions ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL;
      ALTER TABLE claude_sessions ADD COLUMN cwd TEXT;
      ALTER TABLE claude_sessions ADD COLUMN git_branch TEXT;
    `);

    // 索引
    db.exec(`
      CREATE INDEX idx_claude_sessions_task ON claude_sessions(task_id);
      CREATE INDEX idx_claude_sessions_goal ON claude_sessions(goal_id);
    `);

    // 回填 task_id + goal_id
    db.exec(`
      UPDATE claude_sessions SET task_id = t.id, goal_id = t.goal_id
      FROM tasks t
      WHERE claude_sessions.channel_id = t.channel_id
        AND claude_sessions.task_id IS NULL AND t.channel_id IS NOT NULL;
    `);

    // 回填 cwd + git_branch
    db.exec(`
      UPDATE claude_sessions
      SET cwd = COALESCE(claude_sessions.cwd, ch.cwd),
          git_branch = COALESCE(claude_sessions.git_branch, ch.worktree_branch)
      FROM channels ch
      WHERE claude_sessions.channel_id = ch.id
        AND (claude_sessions.cwd IS NULL OR claude_sessions.git_branch IS NULL);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_claude_sessions_task;
      DROP INDEX IF EXISTS idx_claude_sessions_goal;
    `);
    // SQLite 3.35+ supports DROP COLUMN
    db.exec(`
      ALTER TABLE claude_sessions DROP COLUMN task_id;
      ALTER TABLE claude_sessions DROP COLUMN goal_id;
      ALTER TABLE claude_sessions DROP COLUMN cwd;
      ALTER TABLE claude_sessions DROP COLUMN git_branch;
    `);
  },
};

export default migration;
