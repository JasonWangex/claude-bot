/**
 * IClaudeSessionRepo 的 SQLite 实现
 *
 * 管理 Claude CLI 会话实体的 CRUD。
 * 主键: id (UUID)
 */

import type Database from 'better-sqlite3';
import type { IClaudeSessionRepo } from '../../types/repository.js';
import type { ClaudeSession } from '../../types/index.js';
import type { ClaudeSessionRow } from '../../types/db.js';

// ==================== 转换函数 ====================

function rowToClaudeSession(row: ClaudeSessionRow): ClaudeSession {
  return {
    id: row.id,
    claudeSessionId: row.claude_session_id ?? undefined,
    prevClaudeSessionId: row.prev_claude_session_id ?? undefined,
    channelId: row.channel_id ?? undefined,
    model: row.model ?? undefined,
    planMode: row.plan_mode === 1 ? true : false,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
    purpose: row.purpose ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
  };
}

function claudeSessionToParams(session: ClaudeSession): Record<string, unknown> {
  return {
    id: session.id,
    claude_session_id: session.claudeSessionId ?? null,
    prev_claude_session_id: session.prevClaudeSessionId ?? null,
    channel_id: session.channelId ?? null,
    model: session.model ?? null,
    plan_mode: session.planMode ? 1 : 0,
    status: session.status,
    created_at: session.createdAt,
    closed_at: session.closedAt ?? null,
    purpose: session.purpose ?? null,
    parent_session_id: session.parentSessionId ?? null,
  };
}

// ==================== Repository 实现 ====================

export class ClaudeSessionRepository implements IClaudeSessionRepo {
  private stmts!: {
    get: Database.Statement;
    getByChannel: Database.Statement;
    getActiveByChannel: Database.Statement;
    findByClaudeSessionId: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    close: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      get: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE id = ?`,
      ),

      getByChannel: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE channel_id = ? ORDER BY created_at DESC`,
      ),

      getActiveByChannel: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE channel_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      ),

      findByClaudeSessionId: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE claude_session_id = ?`,
      ),

      getAll: this.db.prepare(`SELECT * FROM claude_sessions`),

      upsert: this.db.prepare(`
        INSERT INTO claude_sessions (
          id, claude_session_id, prev_claude_session_id,
          channel_id, model, plan_mode, status, created_at, closed_at,
          purpose, parent_session_id
        ) VALUES (
          @id, @claude_session_id, @prev_claude_session_id,
          @channel_id, @model, @plan_mode, @status, @created_at, @closed_at,
          @purpose, @parent_session_id
        )
        ON CONFLICT(id) DO UPDATE SET
          claude_session_id = @claude_session_id,
          prev_claude_session_id = @prev_claude_session_id,
          channel_id = @channel_id,
          model = @model,
          plan_mode = @plan_mode,
          status = @status,
          closed_at = @closed_at,
          purpose = @purpose,
          parent_session_id = @parent_session_id
      `),

      close: this.db.prepare(`
        UPDATE claude_sessions
        SET status = 'closed',
            closed_at = ?
        WHERE id = ?
      `),
    };
  }

  // ==================== IClaudeSessionRepo CRUD ====================

  async get(id: string): Promise<ClaudeSession | null> {
    const row = this.stmts.get.get(id) as ClaudeSessionRow | undefined;
    if (!row) return null;
    return rowToClaudeSession(row);
  }

  async getByChannel(channelId: string): Promise<ClaudeSession[]> {
    const rows = this.stmts.getByChannel.all(channelId) as ClaudeSessionRow[];
    return rows.map((row) => rowToClaudeSession(row));
  }

  async getActiveByChannel(channelId: string): Promise<ClaudeSession | null> {
    const row = this.stmts.getActiveByChannel.get(channelId) as ClaudeSessionRow | undefined;
    if (!row) return null;
    return rowToClaudeSession(row);
  }

  async findByClaudeSessionId(claudeSessionId: string): Promise<ClaudeSession | null> {
    const row = this.stmts.findByClaudeSessionId.get(claudeSessionId) as ClaudeSessionRow | undefined;
    if (!row) return null;
    return rowToClaudeSession(row);
  }

  async save(session: ClaudeSession): Promise<void> {
    this.stmts.upsert.run(claudeSessionToParams(session));
  }

  async close(id: string): Promise<boolean> {
    const result = this.stmts.close.run(Date.now(), id);
    return result.changes > 0;
  }

  // ==================== 额外公开方法（启动时批量加载用）====================

  /** 加载所有 claude_sessions，用于启动时填充内存 */
  loadAll(): ClaudeSession[] {
    const rows = this.stmts.getAll.all() as ClaudeSessionRow[];
    return rows.map((row) => rowToClaudeSession(row));
  }
}
