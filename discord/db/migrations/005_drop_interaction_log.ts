import type { Migration } from '../migrate.js';

/**
 * Migration 005: 删除 interaction_log 表
 *
 * 原 005_add_interaction_log.ts 创建了该表，但后续决定不使用此表，
 * 改为直接使用 JSONL 文件存储交互日志。因此将原 migration 替换为删除表的操作。
 */
const migration: Migration = {
  version: 5,
  name: 'drop_interaction_log',

  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS interaction_log;
    `);
  },

  down(db) {
    // 不可逆 migration：无法恢复已删除的数据
    // 如果需要恢复表结构，请参考 git history 中的原 005_add_interaction_log.ts
  },
};

export default migration;
