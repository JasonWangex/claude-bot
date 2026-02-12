/**
 * SQLite SessionRepo 实现
 *
 * 实现 ISessionRepo 接口，管理 sessions + message_history + archived_sessions 表。
 */

import type Database from 'better-sqlite3';
import type { ISessionRepo } from '../../types/repository.js';
import type { Session, ArchivedSession } from '../../types/index.js';
import type { SessionRow, MessageHistoryRow, ArchivedSessionRow } from '../../types/db.js';

// ==================== Row ↔ Domain 转换 ====================

function sessionToRow(s: Session): SessionRow {
  return {
    id: s.id,
    name: s.name,
    thread_id: s.threadId,
    guild_id: s.guildId,
    claude_session_id: s.claudeSessionId ?? null,
    prev_claude_session_id: s.prevClaudeSessionId ?? null,
    cwd: s.cwd,
    created_at: s.createdAt,
    last_message: s.lastMessage ?? null,
    last_message_at: s.lastMessageAt ?? null,
    plan_mode: s.planMode ? 1 : 0,
    model: s.model ?? null,
    parent_thread_id: s.parentThreadId ?? null,
    worktree_branch: s.worktreeBranch ?? null,
  };
}

function rowToSession(row: SessionRow, history: MessageHistoryRow[]): Session {
  return {
    id: row.id,
    name: row.name,
    threadId: row.thread_id,
    guildId: row.guild_id,
    claudeSessionId: row.claude_session_id ?? undefined,
    prevClaudeSessionId: row.prev_claude_session_id ?? undefined,
    cwd: row.cwd,
    createdAt: row.created_at,
    lastMessage: row.last_message ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
    planMode: row.plan_mode === 1 ? true : undefined,
    model: row.model ?? undefined,
    messageHistory: history.map(h => ({
      role: h.role,
      text: h.text,
      timestamp: h.timestamp,
    })),
    parentThreadId: row.parent_thread_id ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
  };
}

function archivedRowToSession(row: ArchivedSessionRow, history: MessageHistoryRow[]): ArchivedSession {
  return {
    ...rowToSession(row, history),
    archivedAt: row.archived_at,
    archivedBy: row.archived_by ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
  };
}

// ==================== SessionRepo ====================

export class SessionRepo implements ISessionRepo {
  private db: Database.Database;

  // Prepared statements (lazy-initialized)
  private _stmts?: ReturnType<SessionRepo['prepareStatements']>;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private get stmts() {
    if (!this._stmts) {
      this._stmts = this.prepareStatements();
    }
    return this._stmts;
  }

  private prepareStatements() {
    return {
      // sessions
      getByGuildThread: this.db.prepare<[string, string]>(
        `SELECT * FROM sessions WHERE guild_id = ? AND thread_id = ?`
      ),
      getAllByGuild: this.db.prepare<[string]>(
        `SELECT * FROM sessions WHERE guild_id = ? ORDER BY created_at DESC`
      ),
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
          cwd, created_at, last_message, last_message_at, plan_mode, model, parent_thread_id, worktree_branch)
        VALUES (@id, @name, @thread_id, @guild_id, @claude_session_id, @prev_claude_session_id,
          @cwd, @created_at, @last_message, @last_message_at, @plan_mode, @model, @parent_thread_id, @worktree_branch)
        ON CONFLICT(guild_id, thread_id) DO UPDATE SET
          name = excluded.name,
          claude_session_id = excluded.claude_session_id,
          prev_claude_session_id = excluded.prev_claude_session_id,
          cwd = excluded.cwd,
          last_message = excluded.last_message,
          last_message_at = excluded.last_message_at,
          plan_mode = excluded.plan_mode,
          model = excluded.model,
          parent_thread_id = excluded.parent_thread_id,
          worktree_branch = excluded.worktree_branch
      `),
      deleteSession: this.db.prepare<[string, string]>(
        `DELETE FROM sessions WHERE guild_id = ? AND thread_id = ?`
      ),
      findByClaudeSession: this.db.prepare<[string, string]>(
        `SELECT * FROM sessions WHERE guild_id = ? AND claude_session_id = ?`
      ),
      findByParentThread: this.db.prepare<[string, string]>(
        `SELECT * FROM sessions WHERE guild_id = ? AND parent_thread_id = ? ORDER BY created_at DESC`
      ),
      countAll: this.db.prepare(
        `SELECT COUNT(*) as cnt FROM sessions`
      ),

      // message_history
      getHistory: this.db.prepare<[string]>(
        `SELECT * FROM message_history WHERE session_id = ? ORDER BY timestamp ASC`
      ),
      deleteHistory: this.db.prepare<[string]>(
        `DELETE FROM message_history WHERE session_id = ?`
      ),
      insertHistory: this.db.prepare(`
        INSERT INTO message_history (session_id, role, text, timestamp)
        VALUES (@session_id, @role, @text, @timestamp)
      `),

      // archived_sessions
      getArchivedByGuildThread: this.db.prepare<[string, string]>(
        `SELECT * FROM archived_sessions WHERE guild_id = ? AND thread_id = ?`
      ),
      getAllArchivedByGuild: this.db.prepare<[string]>(
        `SELECT * FROM archived_sessions WHERE guild_id = ? ORDER BY archived_at DESC`
      ),
      insertArchived: this.db.prepare(`
        INSERT INTO archived_sessions (id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
          cwd, created_at, last_message, last_message_at, plan_mode, model, parent_thread_id, worktree_branch,
          archived_at, archived_by, archive_reason)
        VALUES (@id, @name, @thread_id, @guild_id, @claude_session_id, @prev_claude_session_id,
          @cwd, @created_at, @last_message, @last_message_at, @plan_mode, @model, @parent_thread_id, @worktree_branch,
          @archived_at, @archived_by, @archive_reason)
      `),
      deleteArchived: this.db.prepare<[string, string]>(
        `DELETE FROM archived_sessions WHERE guild_id = ? AND thread_id = ?`
      ),

      // archive helper: get session by id (for moving data)
      getSessionById: this.db.prepare<[string]>(
        `SELECT * FROM sessions WHERE id = ?`
      ),
    };
  }

  // ==================== CRUD ====================

  async get(guildId: string, threadId: string): Promise<Session | null> {
    const row = this.stmts.getByGuildThread.get(guildId, threadId) as SessionRow | undefined;
    if (!row) return null;
    const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
    return rowToSession(row, history);
  }

  async getAll(guildId: string): Promise<Session[]> {
    const rows = this.stmts.getAllByGuild.all(guildId) as SessionRow[];
    return rows.map(row => {
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
      return rowToSession(row, history);
    });
  }

  async save(session: Session): Promise<void> {
    const row = sessionToRow(session);
    const saveTransaction = this.db.transaction(() => {
      this.stmts.upsertSession.run(row);
      // Replace message history: delete old, insert new
      this.stmts.deleteHistory.run(session.id);
      for (const msg of session.messageHistory) {
        this.stmts.insertHistory.run({
          session_id: session.id,
          role: msg.role,
          text: msg.text,
          timestamp: msg.timestamp,
        });
      }
    });
    saveTransaction();
  }

  async delete(guildId: string, threadId: string): Promise<boolean> {
    // message_history 通过 ON DELETE CASCADE 自动删除
    const result = this.stmts.deleteSession.run(guildId, threadId);
    return result.changes > 0;
  }

  // ==================== 查询 ====================

  async findByClaudeSessionId(guildId: string, claudeSessionId: string): Promise<Session | null> {
    const row = this.stmts.findByClaudeSession.get(guildId, claudeSessionId) as SessionRow | undefined;
    if (!row) return null;
    const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
    return rowToSession(row, history);
  }

  async findByParentThreadId(guildId: string, parentThreadId: string): Promise<Session[]> {
    const rows = this.stmts.findByParentThread.all(guildId, parentThreadId) as SessionRow[];
    return rows.map(row => {
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
      return rowToSession(row, history);
    });
  }

  // ==================== 归档 ====================

  async archive(guildId: string, threadId: string, userId?: string, reason?: string): Promise<boolean> {
    const archiveTransaction = this.db.transaction(() => {
      const row = this.stmts.getByGuildThread.get(guildId, threadId) as SessionRow | undefined;
      if (!row) return false;

      // 获取 message_history（归档前保存）
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];

      // 写入 archived_sessions
      const archivedRow: ArchivedSessionRow = {
        ...row,
        archived_at: Date.now(),
        archived_by: userId ?? null,
        archive_reason: reason ?? null,
      };
      this.stmts.insertArchived.run(archivedRow);

      // 删除原 session（CASCADE 删除 message_history）
      this.stmts.deleteSession.run(guildId, threadId);

      // 将 message_history 写入 archived 的 session_id 下（archived_sessions 不在 FK 中）
      // 注意: archived_sessions 没有 message_history FK，归档的消息记录
      // 内嵌在 archived session 读取时不需要单独查询
      // 但为了保持一致性，我们不在 archived 中保留 message_history
      // 归档后 message_history 随 CASCADE 删除

      return true;
    });

    return archiveTransaction() as boolean;
  }

  async restore(guildId: string, threadId: string): Promise<boolean> {
    const restoreTransaction = this.db.transaction(() => {
      const row = this.stmts.getArchivedByGuildThread.get(guildId, threadId) as ArchivedSessionRow | undefined;
      if (!row) return false;

      // 从 archived 取出 session 字段，插入 sessions 表
      const sessionRow: SessionRow = {
        id: row.id,
        name: row.name,
        thread_id: row.thread_id,
        guild_id: row.guild_id,
        claude_session_id: row.claude_session_id,
        prev_claude_session_id: row.prev_claude_session_id,
        cwd: row.cwd,
        created_at: row.created_at,
        last_message: row.last_message,
        last_message_at: row.last_message_at,
        plan_mode: row.plan_mode,
        model: row.model,
        parent_thread_id: row.parent_thread_id,
        worktree_branch: row.worktree_branch,
      };
      this.stmts.upsertSession.run(sessionRow);

      // 删除 archived 记录
      this.stmts.deleteArchived.run(guildId, threadId);

      return true;
    });

    return restoreTransaction() as boolean;
  }

  async getArchived(guildId: string, threadId: string): Promise<ArchivedSession | null> {
    const row = this.stmts.getArchivedByGuildThread.get(guildId, threadId) as ArchivedSessionRow | undefined;
    if (!row) return null;
    // 归档后 message_history 已删除，返回空数组
    return archivedRowToSession(row, []);
  }

  async getAllArchived(guildId: string): Promise<ArchivedSession[]> {
    const rows = this.stmts.getAllArchivedByGuild.all(guildId) as ArchivedSessionRow[];
    return rows.map(row => archivedRowToSession(row, []));
  }

  // ==================== 统计 ====================

  async count(): Promise<number> {
    const row = this.stmts.countAll.get() as { cnt: number };
    return row.cnt;
  }
}
