import type { Migration } from '../migrate.js';

/**
 * Migration 052: goals 表重构
 *
 * 1. 重命名 drive_* 字段（去掉 drive_ 前缀）
 * 2. 将 drive_status 的值合并到 status 列，然后删除 drive_status
 * 3. 删除废弃列：drive_created_at, drive_updated_at, progress, next, blocked_by
 */
const migration: Migration = {
  version: 52,
  name: 'goal_schema_refactor',

  up(db) {
    // 字段重命名（SQLite 3.25+）
    db.exec(`
      ALTER TABLE goals RENAME COLUMN drive_branch TO branch;
      ALTER TABLE goals RENAME COLUMN drive_thread_id TO channel_id;
      ALTER TABLE goals RENAME COLUMN drive_base_cwd TO cwd;
      ALTER TABLE goals RENAME COLUMN drive_max_concurrent TO max_concurrent;
    `);

    // 将 drive_status 合并到 status（drive_status 的语义更准确）
    db.exec(`
      UPDATE goals SET status = 'Processing' WHERE drive_status = 'running';
      UPDATE goals SET status = 'Paused'     WHERE drive_status = 'paused';
      UPDATE goals SET status = 'Completed'  WHERE drive_status = 'completed';
      UPDATE goals SET status = 'Failed'     WHERE drive_status = 'failed';
    `);

    // 删除废弃列（SQLite 3.35+）
    db.exec(`
      ALTER TABLE goals DROP COLUMN drive_status;
      ALTER TABLE goals DROP COLUMN drive_created_at;
      ALTER TABLE goals DROP COLUMN drive_updated_at;
      ALTER TABLE goals DROP COLUMN progress;
      ALTER TABLE goals DROP COLUMN next;
      ALTER TABLE goals DROP COLUMN blocked_by;
    `);
  },

  down(db) {
    db.exec(`
      ALTER TABLE goals ADD COLUMN drive_status TEXT;
      ALTER TABLE goals ADD COLUMN drive_created_at INTEGER;
      ALTER TABLE goals ADD COLUMN drive_updated_at INTEGER;
      ALTER TABLE goals ADD COLUMN progress TEXT;
      ALTER TABLE goals ADD COLUMN next TEXT;
      ALTER TABLE goals ADD COLUMN blocked_by TEXT;
    `);

    db.exec(`
      UPDATE goals SET drive_status = 'running'   WHERE status = 'Processing';
      UPDATE goals SET drive_status = 'paused'    WHERE status = 'Paused';
      UPDATE goals SET drive_status = 'completed' WHERE status = 'Completed';
      UPDATE goals SET drive_status = 'failed'    WHERE status = 'Failed';
    `);

    db.exec(`
      ALTER TABLE goals RENAME COLUMN branch TO drive_branch;
      ALTER TABLE goals RENAME COLUMN channel_id TO drive_thread_id;
      ALTER TABLE goals RENAME COLUMN cwd TO drive_base_cwd;
      ALTER TABLE goals RENAME COLUMN max_concurrent TO drive_max_concurrent;
    `);
  },
};

export default migration;
