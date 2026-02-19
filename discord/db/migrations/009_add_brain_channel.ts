import type { Migration } from '../migrate.js';
import { seedPromptConfigs } from '../seeds/prompt-seeds.js';

/**
 * 为 Goal 新增 brain channel 列 + brain prompt 种子数据
 *
 * Brain 是 Goal 的专属持久化 Opus session，用于战略决策（评估/失败分析/重规划）。
 * seedPromptConfigs 使用 INSERT OR IGNORE，已有记录不会被覆盖，仅插入新增的 brain prompt。
 */
const migration: Migration = {
  version: 9,
  name: 'add_brain_channel',

  up(db) {
    db.exec(`
      ALTER TABLE goals ADD COLUMN drive_brain_channel_id TEXT;
    `);

    // 写入新增的 brain prompt 种子数据（INSERT OR IGNORE 不影响已有记录）
    seedPromptConfigs(db);
  },

  down(db) {
    // SQLite 不支持 DROP COLUMN（3.35.0+ 才支持），创建临时表迁移
    db.exec(`
      CREATE TABLE goals_backup AS SELECT
        id, name, status, type, project, date, completion, progress, next, blocked_by, body, seq,
        drive_status, drive_branch, drive_thread_id, drive_base_cwd,
        drive_max_concurrent, drive_created_at, drive_updated_at, drive_pending_json
      FROM goals;
      DROP TABLE goals;
      ALTER TABLE goals_backup RENAME TO goals;
    `);
  },
};

export default migration;
