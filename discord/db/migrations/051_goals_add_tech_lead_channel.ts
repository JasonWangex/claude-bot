import type { Migration } from '../migrate.js';

/**
 * Migration 051: goals 表新增 tech_lead_channel_id 列
 *
 * 将原 drive_pending_json 中的 techLeadChannelId 提取为独立列，
 * 并移除 drive_pending_json（pendingRollback 随 rollback 功能一起废弃）。
 *
 * 迁移步骤：
 * 1. 新增 tech_lead_channel_id 列
 * 2. 从现有 drive_pending_json 中解析并回填 tech_lead_channel_id
 * 3. 删除 drive_pending_json 列（SQLite 3.35+ 支持 DROP COLUMN）
 */
const migration: Migration = {
  version: 51,
  name: 'goals_add_tech_lead_channel',

  up(db) {
    db.exec(`
      ALTER TABLE goals ADD COLUMN tech_lead_channel_id TEXT;
    `);

    // 从 drive_pending_json 回填 tech_lead_channel_id
    const rows = db.prepare(`SELECT id, drive_pending_json FROM goals WHERE drive_pending_json IS NOT NULL`).all() as Array<{ id: string; drive_pending_json: string }>;
    const update = db.prepare(`UPDATE goals SET tech_lead_channel_id = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.drive_pending_json);
        if (parsed?.techLeadChannelId) {
          update.run(parsed.techLeadChannelId, row.id);
        }
      } catch {
        // JSON 解析失败，跳过
      }
    }

    // SQLite 3.35+ 支持 DROP COLUMN，WSL2 内核一般支持
    db.exec(`ALTER TABLE goals DROP COLUMN drive_pending_json;`);
  },

  down(db) {
    db.exec(`ALTER TABLE goals ADD COLUMN drive_pending_json TEXT;`);

    // 将 tech_lead_channel_id 回写到 drive_pending_json
    const rows = db.prepare(`SELECT id, tech_lead_channel_id FROM goals WHERE tech_lead_channel_id IS NOT NULL`).all() as Array<{ id: string; tech_lead_channel_id: string }>;
    const update = db.prepare(`UPDATE goals SET drive_pending_json = ? WHERE id = ?`);
    for (const row of rows) {
      update.run(JSON.stringify({ techLeadChannelId: row.tech_lead_channel_id }), row.id);
    }

    db.exec(`ALTER TABLE goals DROP COLUMN tech_lead_channel_id;`);
  },
};

export default migration;
