/**
 * InteractionLog SQLite Repository 实现
 *
 * 提供 interaction_log 表的批量写入和查询操作。
 */

import type Database from 'better-sqlite3';
import type { InteractionLogRow } from '../types/db.js';

export class InteractionLogRepository {
  private stmts: {
    insert: Database.Statement;
    findBySession: Database.Statement;
    deleteBySession: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(`
        INSERT OR IGNORE INTO interaction_log
          (session_id, turn_index, role, content_type, summary_text, model, tokens_input, tokens_output, cost_usd, jsonl_path, created_at)
        VALUES (@session_id, @turn_index, @role, @content_type, @summary_text, @model, @tokens_input, @tokens_output, @cost_usd, @jsonl_path, @created_at)
      `),
      findBySession: db.prepare('SELECT * FROM interaction_log WHERE session_id = ? ORDER BY turn_index, role'),
      deleteBySession: db.prepare('DELETE FROM interaction_log WHERE session_id = ?'),
    };
  }

  /**
   * 批量插入交互日志记录（使用事务）
   * INSERT OR IGNORE 保证幂等性，重复插入不会失败
   */
  insertBatch(rows: Omit<InteractionLogRow, 'id'>[]): void {
    const tx = this.db.transaction((rows: Omit<InteractionLogRow, 'id'>[]) => {
      for (const row of rows) {
        this.stmts.insert.run(row);
      }
    });
    tx(rows);
  }

  /**
   * 查询某个 session 的所有交互记录
   */
  findBySession(sessionId: string): InteractionLogRow[] {
    return this.stmts.findBySession.all(sessionId) as InteractionLogRow[];
  }

  /**
   * 删除某个 session 的所有交互记录
   */
  deleteBySession(sessionId: string): number {
    const result = this.stmts.deleteBySession.run(sessionId);
    return result.changes;
  }
}
