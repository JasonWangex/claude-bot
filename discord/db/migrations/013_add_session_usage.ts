import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions 表添加 session 级 token/cost 累计统计列
 *
 * - tokens_in / tokens_out / cache_read_in / cache_write_in: token 计数
 * - cost_usd: 累计费用（美元）
 * - turn_count: 对话轮次
 * - usage_file_offset: JSONL 增量读取偏移量（字节）
 */
const migration: Migration = {
  version: 13,
  name: 'add_session_usage',

  up(db) {
    db.exec(`
      ALTER TABLE claude_sessions ADD COLUMN tokens_in         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN tokens_out        INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN cache_read_in     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN cache_write_in    INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN cost_usd          REAL    NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN turn_count        INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN usage_file_offset INTEGER NOT NULL DEFAULT 0;
    `);
  },

  down(db) {
    // SQLite 3.35+ 支持 DROP COLUMN
    db.exec(`
      ALTER TABLE claude_sessions DROP COLUMN tokens_in;
      ALTER TABLE claude_sessions DROP COLUMN tokens_out;
      ALTER TABLE claude_sessions DROP COLUMN cache_read_in;
      ALTER TABLE claude_sessions DROP COLUMN cache_write_in;
      ALTER TABLE claude_sessions DROP COLUMN cost_usd;
      ALTER TABLE claude_sessions DROP COLUMN turn_count;
      ALTER TABLE claude_sessions DROP COLUMN usage_file_offset;
    `);
  },
};

export default migration;
