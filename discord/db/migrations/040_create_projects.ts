import type { Migration } from '../migrate.js';

/**
 * 创建 projects 表
 *
 * 以文件系统目录名作为主键，关联 Discord category + default text channel。
 * 所有业务数据（goals/ideas/devlogs/kb）的 project 字段逻辑上引用此表的 name。
 */
const migration: Migration = {
  version: 40,
  name: 'create_projects',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name        TEXT PRIMARY KEY,   -- 项目文件夹名（与业务表的 project TEXT 对应）
        guild_id    TEXT,               -- Discord Guild ID
        category_id TEXT,               -- Discord Category Channel ID
        channel_id  TEXT,               -- Discord 默认 Text Channel ID
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
  },

  down(db) {
    db.exec(`DROP TABLE IF EXISTS projects;`);
  },
};

export default migration;
