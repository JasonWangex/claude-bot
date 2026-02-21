/**
 * Migration 026: goal_todos 添加 priority 字段
 *
 * priority: '重要' | '高' | '中' | '低'，默认 '中'
 */

import type Database from 'better-sqlite3';

export default {
  version: 26,
  name: 'add_todo_priority',

  up(db: Database.Database): void {
    db.exec(`
      ALTER TABLE goal_todos ADD COLUMN priority TEXT NOT NULL DEFAULT '中'
    `);
  },

  down(db: Database.Database): void {
    // SQLite 不支持 DROP COLUMN（旧版），重建表
    db.exec(`
      CREATE TABLE goal_todos_backup AS SELECT id, goal_id, content, done, source, created_at, updated_at FROM goal_todos;
      DROP TABLE goal_todos;
      ALTER TABLE goal_todos_backup RENAME TO goal_todos;
    `);
  },
};
