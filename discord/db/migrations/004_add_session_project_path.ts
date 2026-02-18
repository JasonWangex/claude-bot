import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions 表添加 project_path 列
 *
 * 存储 Claude 项目目录名（如 `-home-jason-projects-claude-bot`），
 * 用于标识 session 所属项目。由 JSONL 文件所在目录提取。
 */
const migration: Migration = {
  version: 4,
  name: 'add_session_project_path',

  up(db) {
    db.exec(`ALTER TABLE claude_sessions ADD COLUMN project_path TEXT;`);
  },

  down(db) {
    db.exec(`ALTER TABLE claude_sessions DROP COLUMN project_path;`);
  },
};

export default migration;
