/**
 * IChannelRepo 的 SQLite 实现
 *
 * 管理 Discord Channel 实体的 CRUD、归档。
 * 主键: id (Discord Channel ID)
 */

import type Database from 'better-sqlite3';
import type { IChannelRepo } from '../../types/repository.js';
import type { Channel } from '../../types/index.js';
import type { ChannelRow } from '../../types/db.js';

// ==================== 转换函数 ====================

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    cwd: row.cwd,
    worktreeBranch: row.worktree_branch ?? undefined,
    parentChannelId: row.parent_channel_id ?? undefined,
    status: row.status,
    archivedAt: row.archived_at ?? undefined,
    archivedBy: row.archived_by ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
    messageCount: row.message_count,
    createdAt: row.created_at,
    lastMessage: row.last_message ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
  };
}

function channelToParams(channel: Channel): Record<string, unknown> {
  return {
    id: channel.id,
    guild_id: channel.guildId,
    name: channel.name,
    cwd: channel.cwd,
    worktree_branch: channel.worktreeBranch ?? null,
    parent_channel_id: channel.parentChannelId ?? null,
    status: channel.status,
    archived_at: channel.archivedAt ?? null,
    archived_by: channel.archivedBy ?? null,
    archive_reason: channel.archiveReason ?? null,
    message_count: channel.messageCount,
    created_at: channel.createdAt,
    last_message: channel.lastMessage ?? null,
    last_message_at: channel.lastMessageAt ?? null,
  };
}

// ==================== Repository 实现 ====================

export class ChannelRepository implements IChannelRepo {
  private stmts!: {
    get: Database.Statement;
    getByGuild: Database.Statement;
    getByGuildAndStatus: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    archive: Database.Statement;
    restore: Database.Statement;
    count: Database.Statement;
    countByStatus: Database.Statement;
    clearParentRefs: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      get: this.db.prepare(
        `SELECT * FROM channels WHERE id = ?`,
      ),

      getByGuild: this.db.prepare(
        `SELECT * FROM channels WHERE guild_id = ?`,
      ),

      getByGuildAndStatus: this.db.prepare(
        `SELECT * FROM channels WHERE guild_id = ? AND status = ?`,
      ),

      getAll: this.db.prepare(`SELECT * FROM channels`),

      upsert: this.db.prepare(`
        INSERT INTO channels (
          id, guild_id, name, cwd, worktree_branch,
          parent_channel_id, status, archived_at, archived_by, archive_reason,
          message_count, created_at, last_message, last_message_at
        ) VALUES (
          @id, @guild_id, @name, @cwd, @worktree_branch,
          @parent_channel_id, @status, @archived_at, @archived_by, @archive_reason,
          @message_count, @created_at, @last_message, @last_message_at
        )
        ON CONFLICT(id) DO UPDATE SET
          name = @name,
          cwd = @cwd,
          worktree_branch = @worktree_branch,
          parent_channel_id = @parent_channel_id,
          status = @status,
          archived_at = @archived_at,
          archived_by = @archived_by,
          archive_reason = @archive_reason,
          message_count = @message_count,
          last_message = @last_message,
          last_message_at = @last_message_at
      `),

      delete: this.db.prepare(
        `DELETE FROM channels WHERE id = ?`,
      ),

      archive: this.db.prepare(`
        UPDATE channels
        SET status = 'archived',
            archived_at = ?,
            archived_by = ?,
            archive_reason = ?
        WHERE id = ?
      `),

      restore: this.db.prepare(`
        UPDATE channels
        SET status = 'active',
            archived_at = NULL,
            archived_by = NULL,
            archive_reason = NULL
        WHERE id = ?
      `),

      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM channels`),

      countByStatus: this.db.prepare(
        `SELECT COUNT(*) as cnt FROM channels WHERE status = ?`,
      ),

      clearParentRefs: this.db.prepare(
        `UPDATE channels SET parent_channel_id = NULL WHERE guild_id = ? AND parent_channel_id = ?`,
      ),
    };
  }

  // ==================== IChannelRepo CRUD ====================

  async get(channelId: string): Promise<Channel | null> {
    const row = this.stmts.get.get(channelId) as ChannelRow | undefined;
    if (!row) return null;
    return rowToChannel(row);
  }

  async getByGuild(guildId: string): Promise<Channel[]> {
    const rows = this.stmts.getByGuild.all(guildId) as ChannelRow[];
    return rows.map((row) => rowToChannel(row));
  }

  async getByGuildAndStatus(guildId: string, status: 'active' | 'archived'): Promise<Channel[]> {
    const rows = this.stmts.getByGuildAndStatus.all(guildId, status) as ChannelRow[];
    return rows.map((row) => rowToChannel(row));
  }

  async save(channel: Channel): Promise<void> {
    this.stmts.upsert.run(channelToParams(channel));
  }

  async delete(channelId: string): Promise<boolean> {
    const result = this.stmts.delete.run(channelId);
    return result.changes > 0;
  }

  // ==================== IChannelRepo 归档 ====================

  async archive(channelId: string, userId?: string, reason?: string): Promise<boolean> {
    const result = this.stmts.archive.run(
      Date.now(),
      userId ?? null,
      reason ?? null,
      channelId,
    );
    return result.changes > 0;
  }

  async restore(channelId: string): Promise<boolean> {
    const result = this.stmts.restore.run(channelId);
    return result.changes > 0;
  }

  // ==================== IChannelRepo 统计 ====================

  async count(status?: 'active' | 'archived'): Promise<number> {
    if (status) {
      const result = this.stmts.countByStatus.get(status) as { cnt: number };
      return result.cnt;
    }
    const result = this.stmts.count.get() as { cnt: number };
    return result.cnt;
  }

  // ==================== 额外公开方法（启动时批量加载用）====================

  /** 加载所有 channels，用于启动时填充内存 */
  loadAll(): Channel[] {
    const rows = this.stmts.getAll.all() as ChannelRow[];
    return rows.map((row) => rowToChannel(row));
  }

  /** 清除指定 parent_channel_id 的引用（父 channel 归档/删除时调用） */
  clearParentRefs(guildId: string, parentChannelId: string): void {
    this.stmts.clearParentRefs.run(guildId, parentChannelId);
  }
}
