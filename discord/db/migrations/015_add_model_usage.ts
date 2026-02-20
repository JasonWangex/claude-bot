import type { Migration } from '../migrate.js';

/**
 * 为 claude_sessions 表添加 model_usage 列
 *
 * 存储每个模型的独立 token/cost 统计（JSON 格式），
 * 以便追踪子代理使用不同模型时的分项消耗。
 *
 * 格式示例：
 * {
 *   "claude-sonnet-4-6": { "tokens_in": 50000, "tokens_out": 3000, "cache_read_in": 0, "cache_write_in": 0, "cost_usd": 0.12, "turn_count": 5 },
 *   "claude-opus-4-6":   { "tokens_in": 20000, "tokens_out": 1000, "cache_read_in": 0, "cache_write_in": 0, "cost_usd": 0.45, "turn_count": 2 }
 * }
 */
const migration: Migration = {
  version: 15,
  name: 'add_model_usage',

  up(db) {
    db.exec(`
      ALTER TABLE claude_sessions ADD COLUMN model_usage TEXT;
    `);
  },

  down(db) {
    db.exec(`
      ALTER TABLE claude_sessions DROP COLUMN model_usage;
    `);
  },
};

export default migration;
