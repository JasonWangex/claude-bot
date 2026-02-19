import type { Migration } from '../migrate.js';

/**
 * 为 tasks 表新增 detail_plan 列
 *
 * 存储从 Goal body 解析后格式化的详细计划文本，
 * 在 startDrive 时一次性写入，pipeline 执行时直接读取。
 */
const migration: Migration = {
  version: 10,
  name: 'add_task_detail_plan',

  up(db) {
    db.exec(`ALTER TABLE tasks ADD COLUMN detail_plan TEXT;`);
  },

  down(db) {
    // SQLite 3.35.0+ 支持 DROP COLUMN
    db.exec(`ALTER TABLE tasks DROP COLUMN detail_plan;`);
  },
};

export default migration;
