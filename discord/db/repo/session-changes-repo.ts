/**
 * SessionChanges SQLite Repository
 *
 * 存储每次 bot session 产生的文件变更（FileChange[]）。
 * 取代原先生成 HTML 并上传 OSS/Discord 附件的方式。
 */

import type Database from 'better-sqlite3';
import type { FileChange } from '../../types/index.js';

export interface SessionChangesRecord {
  id: number;
  channelId: string;
  fileChanges: FileChange[];
  fileCount: number;
  createdAt: number;
}

interface SessionChangesRow {
  id: number;
  channel_id: string;
  file_changes: string;
  file_count: number;
  created_at: number;
}

function rowToRecord(row: SessionChangesRow): SessionChangesRecord {
  let fileChanges: FileChange[] = [];
  try {
    fileChanges = JSON.parse(row.file_changes) as FileChange[];
  } catch {
    // 数据损坏时降级为空数组，不让单行错误影响调用方
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    fileChanges,
    fileCount: row.file_count,
    createdAt: row.created_at,
  };
}

export class SessionChangesRepo {
  constructor(private db: Database.Database) {}

  /** 保存一次 session 的文件变更，返回新记录 id */
  save(channelId: string, fileChanges: FileChange[]): number {
    const result = this.db
      .prepare(`
        INSERT INTO session_changes (channel_id, file_changes, file_count, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(channelId, JSON.stringify(fileChanges), fileChanges.length, Date.now());
    return result.lastInsertRowid as number;
  }

  /** 按 channel_id 分页查询（不含 file_changes，用于列表） */
  findByChannel(
    channelId: string,
    opts: { page?: number; size?: number } = {},
  ): { items: Omit<SessionChangesRecord, 'fileChanges'>[]; total: number } {
    const size = opts.size ?? 20;
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * size;

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) as cnt FROM session_changes WHERE channel_id = ?`)
        .get(channelId) as { cnt: number }
    ).cnt;

    const rows = this.db
      .prepare(`
        SELECT id, channel_id, file_count, created_at
        FROM session_changes
        WHERE channel_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(channelId, size, offset) as Omit<SessionChangesRow, 'file_changes'>[];

    const items = rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      fileCount: row.file_count,
      createdAt: row.created_at,
    }));

    return { items, total };
  }

  /** 按 id 查询单条记录（含完整 file_changes） */
  getById(id: number): SessionChangesRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM session_changes WHERE id = ?`)
      .get(id) as SessionChangesRow | undefined;
    if (!row) return null;
    return rowToRecord(row);
  }
}
