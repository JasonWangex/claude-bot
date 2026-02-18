/**
 * ChannelSessionLinkRepository
 *
 * channel_session_links 是 append-only 的事件日志：
 * - createLink()   新增一条 link 记录
 * - unlinkSession() 软删除（设置 unlinked_at），不做物理删除
 * - 活跃 link = WHERE unlinked_at IS NULL
 *
 * 索引：
 *   idx_csl_channel_active (channel_id, unlinked_at)   — 查活跃 link
 *   idx_csl_last_message   (last_message_discord_id)   — reply 路由
 */

import type Database from 'better-sqlite3';
import type { ChannelSessionLinkRow } from '../../types/db.js';
import { logger } from '../../utils/logger.js';

export interface ChannelSessionLink {
  channelId: string;
  /** claude_sessions.id（UUID，非 Claude CLI session_id） */
  claudeSessionUuid: string;
  linkedAt: number;
  unlinkedAt?: number;
  /** 该 link 最近一次发出的 Discord 消息 ID（reply 路由用） */
  lastMessageDiscordId?: string;
}

function rowToLink(row: ChannelSessionLinkRow): ChannelSessionLink {
  return {
    channelId: row.channel_id,
    claudeSessionUuid: row.claude_session_id,
    linkedAt: row.linked_at,
    unlinkedAt: row.unlinked_at ?? undefined,
    lastMessageDiscordId: row.last_message_discord_id ?? undefined,
  };
}

export class ChannelSessionLinkRepository {
  private stmts!: {
    insert: Database.Statement;
    unlink: Database.Statement;
    unlinkAllForChannel: Database.Statement;
    getActiveLinks: Database.Statement;
    getByDiscordMessageId: Database.Statement;
    getActiveBySession: Database.Statement;
    updateLastMessageId: Database.Statement;
    getAllForChannel: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      // 新增 link（append-only）
      insert: this.db.prepare(`
        INSERT OR IGNORE INTO channel_session_links
          (channel_id, claude_session_id, linked_at, unlinked_at, last_message_discord_id)
        VALUES
          (@channel_id, @claude_session_id, @linked_at, NULL, NULL)
      `),

      // 软删除：设置 unlinked_at
      unlink: this.db.prepare(`
        UPDATE channel_session_links
        SET unlinked_at = @unlinked_at
        WHERE channel_id = @channel_id
          AND claude_session_id = @claude_session_id
          AND unlinked_at IS NULL
      `),

      // 将 channel 下所有活跃 link 标记为 unlinked（attach 转移时使用）
      unlinkAllForChannel: this.db.prepare(`
        UPDATE channel_session_links
        SET unlinked_at = ?
        WHERE channel_id = ? AND unlinked_at IS NULL
      `),

      // 查 channel 所有活跃 link（走 idx_csl_channel_active）
      getActiveLinks: this.db.prepare(`
        SELECT csl.*, cs.model, cs.claude_session_id AS cs_claude_session_id
        FROM channel_session_links csl
        JOIN claude_sessions cs ON cs.id = csl.claude_session_id
        WHERE csl.channel_id = ? AND csl.unlinked_at IS NULL
        ORDER BY csl.linked_at ASC
      `),

      // 通过 Discord 消息 ID 反查活跃 link（reply 路由，走 idx_csl_last_message）
      getByDiscordMessageId: this.db.prepare(`
        SELECT * FROM channel_session_links
        WHERE last_message_discord_id = ? AND unlinked_at IS NULL
        LIMIT 1
      `),

      // 查某个 claude session UUID 当前 link 到哪个 channel（用于 findSessionHolder）
      getActiveBySession: this.db.prepare(`
        SELECT * FROM channel_session_links
        WHERE claude_session_id = ? AND unlinked_at IS NULL
        LIMIT 1
      `),

      // 更新 last_message_discord_id（消息发出后调用）
      updateLastMessageId: this.db.prepare(`
        UPDATE channel_session_links
        SET last_message_discord_id = @discord_message_id
        WHERE channel_id = @channel_id
          AND claude_session_id = @claude_session_id
          AND unlinked_at IS NULL
      `),

      // 查 channel 所有 link（含历史，用于审计/调试）
      getAllForChannel: this.db.prepare(`
        SELECT * FROM channel_session_links
        WHERE channel_id = ?
        ORDER BY linked_at ASC
      `),
    };
  }

  /**
   * 创建 link（前台 Claude session 创建时调用）
   */
  createLink(channelId: string, claudeSessionUuid: string): void {
    const result = this.stmts.insert.run({
      channel_id: channelId,
      claude_session_id: claudeSessionUuid,
      linked_at: Date.now(),
    });
    if (result.changes === 0) {
      logger.warn(`[LinkRepo] createLink ignored (duplicate or FK violation): channel=${channelId}, uuid=${claudeSessionUuid.slice(0, 8)}`);
    }
  }

  /**
   * 软删除指定 link（unlink）
   */
  unlinkSession(channelId: string, claudeSessionUuid: string): void {
    this.stmts.unlink.run({
      channel_id: channelId,
      claude_session_id: claudeSessionUuid,
      unlinked_at: Date.now(),
    });
  }

  /**
   * 将 channel 下所有活跃 link 全部 unlink（attach 转移时使用）
   */
  unlinkAllForChannel(channelId: string): void {
    this.stmts.unlinkAllForChannel.run(Date.now(), channelId);
  }

  /**
   * 获取 channel 所有活跃 link（含 model 信息）
   * 返回结果带有 model 和原始 claudeSessionId（CLI 层），方便消息标头生成
   */
  getActiveLinks(channelId: string): Array<ChannelSessionLink & { model?: string; claudeSessionId?: string }> {
    const rows = this.stmts.getActiveLinks.all(channelId) as Array<ChannelSessionLinkRow & { model: string | null; cs_claude_session_id: string | null }>;
    return rows.map(row => ({
      ...rowToLink(row),
      model: row.model ?? undefined,
      claudeSessionId: row.cs_claude_session_id ?? undefined,
    }));
  }

  /**
   * 通过 Discord 消息 ID 反查 link（reply 路由）
   * 返回 null 表示该消息不属于任何活跃 link
   */
  getByDiscordMessageId(discordMessageId: string): ChannelSessionLink | null {
    const row = this.stmts.getByDiscordMessageId.get(discordMessageId) as ChannelSessionLinkRow | undefined;
    return row ? rowToLink(row) : null;
  }

  /**
   * 查某个 claude session UUID 当前 link 到的 channel（用于 findSessionHolder）
   */
  getActiveBySession(claudeSessionUuid: string): ChannelSessionLink | null {
    const row = this.stmts.getActiveBySession.get(claudeSessionUuid) as ChannelSessionLinkRow | undefined;
    return row ? rowToLink(row) : null;
  }

  /**
   * 更新 link 的 last_message_discord_id（消息发出后调用）
   */
  updateLastMessageId(channelId: string, claudeSessionUuid: string, discordMessageId: string): void {
    this.stmts.updateLastMessageId.run({
      channel_id: channelId,
      claude_session_id: claudeSessionUuid,
      discord_message_id: discordMessageId,
    });
  }

  /**
   * 获取 channel 所有 link（含历史）
   */
  getAllForChannel(channelId: string): ChannelSessionLink[] {
    const rows = this.stmts.getAllForChannel.all(channelId) as ChannelSessionLinkRow[];
    return rows.map(rowToLink);
  }
}
