/**
 * ISyncCursorRepo 的 SQLite 实现
 *
 * 管理同步游标的键值存储。
 * 主键: source
 */

import type Database from 'better-sqlite3';
import type { ISyncCursorRepo } from '../../types/repository.js';
import type { SyncCursorRow } from '../../types/db.js';

// ==================== Repository 实现 ====================

export class SyncCursorRepository implements ISyncCursorRepo {
  private stmts!: {
    get: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      get: this.db.prepare(
        `SELECT cursor FROM sync_cursors WHERE source = ?`,
      ),

      upsert: this.db.prepare(`
        INSERT INTO sync_cursors (source, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
      `),

      delete: this.db.prepare(
        `DELETE FROM sync_cursors WHERE source = ?`,
      ),
    };
  }

  // ==================== ISyncCursorRepo 方法 ====================

  async get(source: string): Promise<string | null> {
    const row = this.stmts.get.get(source) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async set(source: string, cursor: string): Promise<void> {
    this.stmts.upsert.run(source, cursor, Date.now());
  }

  async delete(source: string): Promise<boolean> {
    const result = this.stmts.delete.run(source);
    return result.changes > 0;
  }

  // ==================== 额外公开方法 ====================

  /** 加载所有游标，返回 Map */
  loadAll(): Map<string, string> {
    const rows = this.db.prepare(`SELECT * FROM sync_cursors`).all() as SyncCursorRow[];
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.source, row.cursor);
    }
    return map;
  }
}
