import type { Migration } from '../migrate.js';

/**
 * 为 ideas 表添加 type 和 body 字段
 *
 * - type: idea 类型，'manual'（手动输入）或 'todo'（待处理事项），默认 'manual'
 * - body: Markdown 正文内容，可为空
 */
const migration: Migration = {
  version: 41,
  name: 'add_idea_type_body',

  up(db) {
    db.exec(`
      ALTER TABLE ideas ADD COLUMN type TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE ideas ADD COLUMN body TEXT;
    `);
  },

  down(db) {
    // SQLite 不支持直接删列，需重建表
    db.exec(`
      CREATE TABLE ideas_backup AS SELECT id, name, status, project, date, created_at, updated_at FROM ideas;
      DROP TABLE ideas;
      ALTER TABLE ideas_backup RENAME TO ideas;
    `);
  },
};

export default migration;
