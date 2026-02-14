/**
 * ISessionRepo 的 SQLite 实现
 *
 * 管理 Discord Session 的 CRUD、归档。
 * 复合键: (guild_id, thread_id)
 */

import type Database from 'better-sqlite3';
import type { ISessionRepo } from '../../types/repository.js';
import type { Session, ArchivedSession } from '../../types/index.js';
import type { SessionRow, ArchivedSessionRow } from '../../types/db.js';

// ==================== 转换函数 ====================

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    channelId: row.thread_id,
    guildId: row.guild_id,
    claudeSessionId: row.claude_session_id ?? undefined,
    prevClaudeSessionId: row.prev_claude_session_id ?? undefined,
    cwd: row.cwd,
    createdAt: row.created_at,
    lastMessage: row.last_message ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
    planMode: row.plan_mode === 1 ? true : false,
    model: row.model ?? undefined,
    messageCount: row.message_count,
    parentChannelId: row.parent_thread_id ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
  };
}

function rowToArchivedSession(row: ArchivedSessionRow): ArchivedSession {
  return {
    ...rowToSession(row),
    archivedAt: row.archived_at,
    archivedBy: row.archived_by ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
  };
}

function sessionToParams(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    thread_id: session.channelId,
    guild_id: session.guildId,
    claude_session_id: session.claudeSessionId ?? null,
    prev_claude_session_id: session.prevClaudeSessionId ?? null,
    cwd: session.cwd,
    created_at: session.createdAt,
    last_message: session.lastMessage ?? null,
    last_message_at: session.lastMessageAt ?? null,
    plan_mode: session.planMode ? 1 : 0,
    model: session.model ?? null,
    parent_thread_id: session.parentChannelId ?? null,
    worktree_branch: session.worktreeBranch ?? null,
    message_count: session.messageCount,
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
        `SELECT * FROM _deprecated_sessions WHERE guild_id = ? AND thread_id = ?`,
      ),

      getAllByGuild: this.db.prepare(
        `SELECT * FROM _deprecated_sessions WHERE guild_id = ?`,
      ),

      getAll: this.db.prepare(`SELECT * FROM _deprecated_sessions`),

      upsert: this.db.prepare(`
        INSERT INTO _deprecated_sessions (
          id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
          cwd, created_at, last_message, last_message_at, plan_mode, model,
          parent_thread_id, worktree_branch, message_count
        ) VALUES (
          @id, @name, @thread_id, @guild_id, @claude_session_id, @prev_claude_session_id,
          @cwd, @created_at, @last_message, @last_message_at, @plan_mode, @model,
          @parent_thread_id, @worktree_branch, @message_count
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
          worktree_branch = @worktree_branch,
          message_count = @message_count
      `),

      deleteByKey: this.db.prepare(
        `DELETE FROM _deprecated_sessions WHERE guild_id = ? AND thread_id = ?`,
      ),

      deleteById: this.db.prepare(
        `DELETE FROM _deprecated_sessions WHERE id = ?`,
      ),

      findByClaudeSession: this.db.prepare(
        `SELECT * FROM _deprecated_sessions WHERE guild_id = ? AND claude_session_id = ?`,
      ),

      findByParent: this.db.prepare(
        `SELECT * FROM _deprecated_sessions WHERE guild_id = ? AND parent_thread_id = ?`,
      ),

      clearParentRef: this.db.prepare(
        `UPDATE _deprecated_sessions SET parent_thread_id = NULL WHERE guild_id = ? AND parent_thread_id = ?`,
      ),

      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM _deprecated_sessions`),

      updateLastMessage: this.db.prepare(
        `UPDATE _deprecated_sessions SET last_message = ?, last_message_at = ? WHERE id = ?`,
      ),

      getArchivedByKey: this.db.prepare(
        `SELECT * FROM _deprecated_archived_sessions WHERE guild_id = ? AND thread_id = ?`,
      ),

      getAllArchivedByGuild: this.db.prepare(
        `SELECT * FROM _deprecated_archived_sessions WHERE guild_id = ?`,
      ),

      getAllArchived: this.db.prepare(`SELECT * FROM _deprecated_archived_sessions`),

      insertArchived: this.db.prepare(`
        INSERT INTO _deprecated_archived_sessions (
          id, name, thread_id, guild_id, claude_session_id, prev_claude_session_id,
          cwd, created_at, last_message, last_message_at, plan_mode, model,
          parent_thread_id, worktree_branch, message_count, archived_at, archived_by,
          archive_reason, message_history_json
        ) VALUES (
          @id, @name, @thread_id, @guild_id, @claude_session_id, @prev_claude_session_id,
          @cwd, @created_at, @last_message, @last_message_at, @plan_mode, @model,
          @parent_thread_id, @worktree_branch, @message_count, @archived_at, @archived_by,
          @archive_reason, @message_history_json
        )
      `),

      deleteArchived: this.db.prepare(
        `DELETE FROM _deprecated_archived_sessions WHERE guild_id = ? AND thread_id = ?`,
      ),
    };
  }

  // ==================== ISessionRepo CRUD ====================

  async get(guildId: string, channelId: string): Promise<Session | null> {
    const row = this.stmts.getByKey.get(guildId, channelId) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  async getAll(guildId: string): Promise<Session[]> {
    const rows = this.stmts.getAllByGuild.all(guildId) as SessionRow[];
    return rows.map((row) => rowToSession(row));
  }

  async save(session: Session): Promise<void> {
    this.stmts.upsert.run(sessionToParams(session));
  }

  async delete(guildId: string, channelId: string): Promise<boolean> {
    const result = this.stmts.deleteByKey.run(guildId, channelId);
    return result.changes > 0;
  }

  // ==================== ISessionRepo 查询 ====================

  async findByClaudeSessionId(guildId: string, claudeSessionId: string): Promise<Session | null> {
    const row = this.stmts.findByClaudeSession.get(guildId, claudeSessionId) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  async findByParentChannelId(guildId: string, parentChannelId: string): Promise<Session[]> {
    const rows = this.stmts.findByParent.all(guildId, parentChannelId) as SessionRow[];
    return rows.map((row) => rowToSession(row));
  }

  // ==================== ISessionRepo 归档 ====================

  async archive(guildId: string, channelId: string, userId?: string, reason?: string): Promise<boolean> {
    const row = this.stmts.getByKey.get(guildId, channelId) as SessionRow | undefined;
    if (!row) return false;

    const archiveTransaction = this.db.transaction(() => {
      // 插入 archived_sessions（message_history_json 保持 null，因为 message_history 表已废弃）
      this.stmts.insertArchived.run({
        ...sessionToParams(rowToSession(row)),
        archived_at: Date.now(),
        archived_by: userId ?? null,
        archive_reason: reason ?? null,
        message_history_json: null,
      });

      // 删除 sessions
      this.stmts.deleteById.run(row.id);

      // 清除子 session 的 parentChannelId 引用
      this.stmts.clearParentRef.run(guildId, channelId);
    });

    archiveTransaction();
    return true;
  }

  async restore(guildId: string, channelId: string): Promise<boolean> {
    const row = this.stmts.getArchivedByKey.get(guildId, channelId) as ArchivedSessionRow | undefined;
    if (!row) return false;

    const restoreTransaction = this.db.transaction(() => {
      // 插入回 sessions（message_history 表已废弃，无需恢复历史消息）
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
        message_count: row.message_count,
      });

      // 删除 archived_sessions 记录
      this.stmts.deleteArchived.run(guildId, channelId);
    });

    restoreTransaction();
    return true;
  }

  async getArchived(guildId: string, channelId: string): Promise<ArchivedSession | null> {
    const row = this.stmts.getArchivedByKey.get(guildId, channelId) as ArchivedSessionRow | undefined;
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

  /** 加载所有活跃 sessions，用于启动时填充内存 Map */
  loadAllSessions(): Session[] {
    const rows = this.stmts.getAll.all() as SessionRow[];
    return rows.map((row) => rowToSession(row));
  }

  /** 加载所有归档 sessions，用于启动时填充内存 Map */
  loadAllArchived(): ArchivedSession[] {
    const rows = this.stmts.getAllArchived.all() as ArchivedSessionRow[];
    return rows.map(rowToArchivedSession);
  }

  /** 清除子 session 的 parentChannelId 引用 */
  clearParentRefs(guildId: string, parentChannelId: string): void {
    this.stmts.clearParentRef.run(guildId, parentChannelId);
  }
}
