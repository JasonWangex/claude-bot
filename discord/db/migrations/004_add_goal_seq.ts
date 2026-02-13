import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 4,
  name: 'add_goal_seq',

  up(db) {
    // 添加 seq 列：人类可读的短序号，用于命名（g1t1, g2t1 等）
    db.exec(`ALTER TABLE goals ADD COLUMN seq INTEGER;`);

    // 为已有 goal 按创建日期分配 seq
    db.exec(`
      UPDATE goals SET seq = (
        SELECT COUNT(*) FROM goals g2
        WHERE g2.rowid <= goals.rowid
      );
    `);
  },

  down(db) {
    // SQLite 3.35.0+ 支持 DROP COLUMN
    db.exec(`ALTER TABLE goals DROP COLUMN seq;`);
  },
};

export default migration;
