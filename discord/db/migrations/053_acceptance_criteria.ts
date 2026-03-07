import type { Migration } from '../migrate.js';

/**
 * Migration 053: 验收标准体系
 *
 * 1. goals: 新增 phase_milestones（phase 里程碑 JSON）
 * 2. tasks: 新增 check-in 持久化字段（checkin_count, last_checkin_at, nudge_count, last_nudge_at）
 */
const migration: Migration = {
  version: 53,
  name: 'acceptance_criteria',

  up(db) {
    db.exec(`
      ALTER TABLE goals ADD COLUMN phase_milestones TEXT;
    `);
    db.exec(`
      ALTER TABLE tasks ADD COLUMN checkin_count   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN last_checkin_at INTEGER;
      ALTER TABLE tasks ADD COLUMN nudge_count     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN last_nudge_at   INTEGER;
    `);
  },

  down(db) {
    db.exec(`ALTER TABLE goals DROP COLUMN phase_milestones;`);
    db.exec(`
      ALTER TABLE tasks DROP COLUMN checkin_count;
      ALTER TABLE tasks DROP COLUMN last_checkin_at;
      ALTER TABLE tasks DROP COLUMN nudge_count;
      ALTER TABLE tasks DROP COLUMN last_nudge_at;
    `);
  },
};

export default migration;
