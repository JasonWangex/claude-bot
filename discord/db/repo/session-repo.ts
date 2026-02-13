/**
 * ISessionRepo 的 SQLite 实现
 *
 * 管理 Discord Session 的 CRUD、归档、消息历史。
 * 复合键: (guild_id, thread_id)
 * 消息历史存储在独立的 message_history 表中。
 */

import type Database from 'better-sqlite3';
import type { ISessionRepo } from '../../types/repository.js';
import type { Session, ArchivedSession } from '../../types/index.js';
import type { SessionRow, MessageHistoryRow, ArchivedSessionRow } from '../../types/db.js';

const MAX_HISTORY = 50;

// ==================== 转换函数 ====================

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
    planMode: row.plan_mode === 1 ? true : false,
    model: row.model ?? undefined,
    messageHistory: history.map((h) => ({
      role: h.role,
      text: h.text,
      timestamp: h.timestamp,
    })),
    parentThreadId: row.parent_thread_id ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
  };
}

function rowToArchivedSession(row: ArchivedSessionRow): ArchivedSession {
  // 从 JSON 恢复归档的 message history
  let history: { role: 'user' | 'assistant'; text: string; timestamp: number }[] = [];
  if (row.message_history_json) {
    try { history = JSON.parse(row.message_history_json); } catch { /* ignore parse errors */ }
  }
  return {
    ...rowToSession(row, []),
    messageHistory: history,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
  };
}

function sessionToParams(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    thread_id: session.threadId,
    guild_id: session.guildId,
    claude_session_id: session.claudeSessionId ?? null,
    prev_claude_session_id: session.prevClaudeSessionId ?? null,
    cwd: session.cwd,
    created_at: session.createdAt,
    last_message: session.lastMessage ?? null,
    last_message_at: session.lastMessageAt ?? null,
    plan_mode: session.planMode ? 1 : 0,
    model: session.model ?? null,
    parent_thread_id: session.parentThreadId ?? null,
    worktree_branch: session.worktreeBranch ?? null,
  };
}

// ==================== Repository 实现 ====================

export class SessionRepository implements ISessionRepo {
  private stmts!: {
    getByKey: Database.Statement;
    getAllByGuild: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    deleteByKey: Database.Statement;
    deleteById: Database.Statement;
    findByClaudeSession: Database.Statement;
    findByParent: Database.Statement;
    clearParentRef: Database.Statement;
    count: Database.Statement;
    getHistory: Database.Statement;
    insertMessage: Database.Statement;
    deleteHistory: Database.Statement;
    trimHistory: Database.Statement;
    updateLastMessage: Database.Statement;
    getArchivedByKey: Database.Statement;
    getAllArchivedByGuild: Database.Statement;
    getAllArchived: Database.Statement;
    insertArchived: Database.Statement;
    deleteArchived: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      getByKey: this.db.prepare(
        `SELECT * FROM sessions WHERE guild_id = ? AND thread_id = ?`,
      ),

      getAllByGuild: this.db.prepare(
        `SELECT * FROM sessions WHERE guild_id = ?`,
      ),

      getAll: this.db.prepare(`SELECT * FROM sessions`),

      upsert: this.db.prepare(`
        INSERT INTO sessions (
          id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
          cwd, created_at, last_message, last_message_at, plan_mode, model,
          parent_thread_id, worktree_branch
        ) VALUES (
          @id, @name, @thread_id, @guild_id, @claude_session_id, @prev_claude_session_id,
          @cwd, @created_at, @last_message, @last_message_at, @plan_mode, @model,
          @parent_thread_id, @worktree_branch
        )
        ON CONFLICT(guild_id, thread_id) DO UPDATE SET
          name = @name,
          claude_session_id = @claude_session_id,
          prev_claude_session_id = @prev_claude_session_id,
          cwd = @cwd,
          last_message = @last_message,
          last_message_at = @last_message_at,
          plan_mode = @plan_mode,
          model = @model,
          parent_thread_id = @parent_thread_id,
          worktree_branch = @worktree_branch
      `),

      deleteByKey: this.db.prepare(
        `DELETE FROM sessions WHERE guild_id = ? AND thread_id = ?`,
      ),

      deleteById: this.db.prepare(
        `DELETE FROM sessions WHERE id = ?`,
      ),

      findByClaudeSession: this.db.prepare(
        `SELECT * FROM sessions WHERE guild_id = ? AND claude_session_id = ?`,
      ),

      findByParent: this.db.prepare(
        `SELECT * FROM sessions WHERE guild_id = ? AND parent_thread_id = ?`,
      ),

      clearParentRef: this.db.prepare(
        `UPDATE sessions SET parent_thread_id = NULL WHERE guild_id = ? AND parent_thread_id = ?`,
      ),

      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM sessions`),

      getHistory: this.db.prepare(
        `SELECT * FROM message_history WHERE session_id = ? ORDER BY timestamp ASC`,
      ),

      insertMessage: this.db.prepare(`
        INSERT INTO message_history (session_id, role, text, timestamp)
        VALUES (@session_id, @role, @text, @timestamp)
      `),

      deleteHistory: this.db.prepare(
        `DELETE FROM message_history WHERE session_id = ?`,
      ),

      trimHistory: this.db.prepare(`
        DELETE FROM message_history WHERE session_id = ? AND id NOT IN (
          SELECT id FROM message_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
        )
      `),

      updateLastMessage: this.db.prepare(
        `UPDATE sessions SET last_message = ?, last_message_at = ? WHERE id = ?`,
      ),

      getArchivedByKey: this.db.prepare(
        `SELECT * FROM archived_sessions WHERE guild_id = ? AND thread_id = ?`,
      ),

      getAllArchivedByGuild: this.db.prepare(
        `SELECT * FROM archived_sessions WHERE guild_id = ?`,
      ),

      getAllArchived: this.db.prepare(`SELECT * FROM archived_sessions`),

      insertArchived: this.db.prepare(`
        INSERT INTO archived_sessions (
          id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
          cwd, created_at, last_message, last_message_at, plan_mode, model,
          parent_thread_id, worktree_branch, archived_at, archived_by, archive_reason,
          message_history_json
        ) VALUES (
          @id, @name, @thread_id, @guild_id, @claude_session_id, @prev_claude_session_id,
          @cwd, @created_at, @last_message, @last_message_at, @plan_mode, @model,
          @parent_thread_id, @worktree_branch, @archived_at, @archived_by, @archive_reason,
          @message_history_json
        )
      `),

      deleteArchived: this.db.prepare(
        `DELETE FROM archived_sessions WHERE guild_id = ? AND thread_id = ?`,
      ),
    };
  }

  // ==================== ISessionRepo CRUD ====================

  async get(guildId: string, threadId: string): Promise<Session | null> {
    const row = this.stmts.getByKey.get(guildId, threadId) as SessionRow | undefined;
    if (!row) return null;
    const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
    return rowToSession(row, history);
  }

  async getAll(guildId: string): Promise<Session[]> {
    const rows = this.stmts.getAllByGuild.all(guildId) as SessionRow[];
    return rows.map((row) => {
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
      return rowToSession(row, history);
    });
  }

  async save(session: Session): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      this.stmts.upsert.run(sessionToParams(session));
      this.stmts.deleteHistory.run(session.id);
      for (const entry of session.messageHistory) {
        this.stmts.insertMessage.run({
          session_id: session.id,
          role: entry.role,
          text: entry.text,
          timestamp: entry.timestamp,
        });
      }
    });
    saveTransaction();
  }

  async delete(guildId: string, threadId: string): Promise<boolean> {
    // CASCADE 自动删除 message_history
    const result = this.stmts.deleteByKey.run(guildId, threadId);
    return result.changes > 0;
  }

  // ==================== ISessionRepo 查询 ====================

  async findByClaudeSessionId(guildId: string, claudeSessionId: string): Promise<Session | null> {
    const row = this.stmts.findByClaudeSession.get(guildId, claudeSessionId) as SessionRow | undefined;
    if (!row) return null;
    const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
    return rowToSession(row, history);
  }

  async findByParentThreadId(guildId: string, parentThreadId: string): Promise<Session[]> {
    const rows = this.stmts.findByParent.all(guildId, parentThreadId) as SessionRow[];
    return rows.map((row) => {
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
      return rowToSession(row, history);
    });
  }

  // ==================== ISessionRepo 归档 ====================

  async archive(guildId: string, threadId: string, userId?: string, reason?: string): Promise<boolean> {
    const row = this.stmts.getByKey.get(guildId, threadId) as SessionRow | undefined;
    if (!row) return false;

    const archiveTransaction = this.db.transaction(() => {
      // 先读取 message history（删除 session 后 CASCADE 会清除）
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
      const historyJson = history.length > 0
        ? JSON.stringify(history.map(h => ({ role: h.role, text: h.text, timestamp: h.timestamp })))
        : null;

      // 插入 archived_sessions（含 message history）
      this.stmts.insertArchived.run({
        ...sessionToParams(rowToSession(row, [])),
        archived_at: Date.now(),
        archived_by: userId ?? null,
        archive_reason: reason ?? null,
        message_history_json: historyJson,
      });

      // 删除 sessions（CASCADE 清理 message_history）
      this.stmts.deleteById.run(row.id);

      // 清除子 session 的 parentThreadId 引用
      this.stmts.clearParentRef.run(guildId, threadId);
    });

    archiveTransaction();
    return true;
  }

  async restore(guildId: string, threadId: string): Promise<boolean> {
    const row = this.stmts.getArchivedByKey.get(guildId, threadId) as ArchivedSessionRow | undefined;
    if (!row) return false;

    const restoreTransaction = this.db.transaction(() => {
      // 插入回 sessions
      this.stmts.upsert.run({
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
      });

      // 恢复 message history
      if (row.message_history_json) {
        try {
          const history = JSON.parse(row.message_history_json) as Array<{ role: string; text: string; timestamp: number }>;
          for (const entry of history) {
            this.stmts.insertMessage.run({
              session_id: row.id,
              role: entry.role,
              text: entry.text,
              timestamp: entry.timestamp,
            });
          }
        } catch { /* ignore parse errors */ }
      }

      // 删除 archived_sessions 记录
      this.stmts.deleteArchived.run(guildId, threadId);
    });

    restoreTransaction();
    return true;
  }

  async getArchived(guildId: string, threadId: string): Promise<ArchivedSession | null> {
    const row = this.stmts.getArchivedByKey.get(guildId, threadId) as ArchivedSessionRow | undefined;
    if (!row) return null;
    return rowToArchivedSession(row);
  }

  async getAllArchived(guildId: string): Promise<ArchivedSession[]> {
    const rows = this.stmts.getAllArchivedByGuild.all(guildId) as ArchivedSessionRow[];
    return rows.map(rowToArchivedSession);
  }

  // ==================== ISessionRepo 统计 ====================

  async count(): Promise<number> {
    const result = this.stmts.count.get() as { cnt: number };
    return result.cnt;
  }

  // ==================== 额外公开方法（StateManager 启动加载用） ====================

  /** 加载所有活跃 sessions（含 message_history），用于启动时填充内存 Map */
  loadAllSessions(): Session[] {
    const rows = this.stmts.getAll.all() as SessionRow[];
    return rows.map((row) => {
      const history = this.stmts.getHistory.all(row.id) as MessageHistoryRow[];
      return rowToSession(row, history);
    });
  }

  /** 加载所有归档 sessions，用于启动时填充内存 Map */
  loadAllArchived(): ArchivedSession[] {
    const rows = this.stmts.getAllArchived.all() as ArchivedSessionRow[];
    return rows.map(rowToArchivedSession);
  }

  // ==================== 消息历史优化方法 ====================

  /**
   * 添加一条消息并裁剪历史（比全量 save 更高效）
   * 同时更新 session 的 last_message/last_message_at
   */
  addMessageAndTrim(
    sessionId: string,
    entry: { role: 'user' | 'assistant'; text: string; timestamp: number },
    lastMessage: string | undefined,
    lastMessageAt: number | undefined,
  ): void {
    const addTransaction = this.db.transaction(() => {
      this.stmts.insertMessage.run({
        session_id: sessionId,
        role: entry.role,
        text: entry.text,
        timestamp: entry.timestamp,
      });
      this.stmts.trimHistory.run(sessionId, sessionId, MAX_HISTORY);
      if (lastMessage !== undefined) {
        this.stmts.updateLastMessage.run(lastMessage, lastMessageAt, sessionId);
      }
    });
    addTransaction();
  }

  /** 清除子 session 的 parentThreadId 引用 */
  clearParentRefs(guildId: string, parentThreadId: string): void {
    this.stmts.clearParentRef.run(guildId, parentThreadId);
  }
}
