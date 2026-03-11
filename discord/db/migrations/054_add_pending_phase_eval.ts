import type { Migration } from '../migrate.js';

/**
 * Migration 054: 新增 pending_phase_eval 与 effort 字段
 *
 * 1. goals: 新增 pending_phase_eval（待评估的 phase）
 * 2. claude_sessions: 新增 effort（Claude CLI effort 级别）
 */
const migration: Migration = {
  version: 54,
  name: 'add_pending_phase_eval',

  up(db) {
    db.exec(`ALTER TABLE goals ADD COLUMN pending_phase_eval TEXT`);
    db.exec(`ALTER TABLE claude_sessions ADD COLUMN effort TEXT`);
  },

  down(db) {
    db.exec(`ALTER TABLE goals DROP COLUMN pending_phase_eval`);
    db.exec(`ALTER TABLE claude_sessions DROP COLUMN effort`);
  },
};

export default migration;
