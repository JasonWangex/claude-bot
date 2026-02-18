/**
 * 状态管理（Guild + Category/Channels 模式）
 * 每个 Text Channel 对应一个独立 Session，不同 channel 并行无干扰
 * ID 全部使用 string (Discord snowflake)
 *
 * 持久化后端：SQLite（通过 SessionRepository + GuildRepository）
 * 内存 Map 作为读缓存，写操作同步写入 SQLite（better-sqlite3 是同步的）
 *
 * Link 体系：
 *   channel : claude_session = 1:N（通过 channel_session_links 表管理）
 *   - 前台 session（用户交互）必须有 link，否则无法向 channel 发消息
 *   - 后台 session（background task）不创建 link
 *   - attach 操作 = 转移 link（旧 session unlink，新 session link）
 */

import { randomUUID } from 'crypto';
import { readFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Session, GuildState, ArchivedSession, Channel, ClaudeSession } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { SessionRepository } from '../db/repo/session-repo.js';
import type { GuildRepository } from '../db/repo/guild-repo.js';
import type { ChannelRepository } from '../db/repo/channel-repo.js';
import type { ClaudeSessionRepository } from '../db/repo/claude-session-repo.js';
import type Database from 'better-sqlite3';
import { resolveSessionContext } from '../sync/session-context.js';
import type { ChannelSessionLinkRepository } from '../db/repo/channel-session-link-repo.js';

const MAX_HISTORY = 50;

// Session 状态追踪（用于 hooks 事件处理）
interface SessionTracking {
  waitingMessageId?: string;      // 等待消息 ID（用于删除）
  waitingTimer?: NodeJS.Timeout;  // 等待消息定时器（用于取消）
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();   // "guildId:channelId" → Session
  private guilds: Map<string, GuildState> = new Map();   // guildId → GuildState
  private archivedSessions: Map<string, ArchivedSession> = new Map();
  private defaultWorkDir: string;

  // Session 状态追踪（hooks 事件处理）
  private sessionTracking: Map<string, SessionTracking> = new Map();  // channelId → SessionTracking

  /**
   * 生成 channel 级别的固定 lockKey，用于 Claude 进程互斥
   */
  static channelLockKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  constructor(
    defaultWorkDir: string,
    private sessionRepo?: SessionRepository,
    private guildRepo?: GuildRepository,
    private channelRepo?: ChannelRepository,
    private claudeSessionRepo?: ClaudeSessionRepository,
    private db?: Database.Database,
    private linkRepo?: ChannelSessionLinkRepository,
  ) {
    this.defaultWorkDir = defaultWorkDir;
  }

  private channelKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  // ========== 加载 ==========

  async load(): Promise<void> {
    if (!this.sessionRepo || !this.guildRepo) {
      logger.warn('StateManager: No repositories provided, running without persistence');
      return;
    }

    // 优先从新表（claude_sessions + channel_session_links）重建内存 Map
    if (this.claudeSessionRepo && this.linkRepo && this.channelRepo) {
      const channels = this.channelRepo.loadAll();
      const rebuilt = this._rebuildFromNewTables(channels);
      if (rebuilt > 0) {
        const guilds = this.guildRepo.loadAll();
        for (const g of guilds) {
          this.guilds.set(g.guildId, g);
        }
        // 归档 sessions 仍从旧表加载（新表暂无归档专用查询）
        const archived = this.sessionRepo.loadAllArchived();
        for (const a of archived) {
          this.archivedSessions.set(this.channelKey(a.guildId, a.channelId), a);
        }
        logger.info(`Loaded ${this.sessions.size} session(s) from new tables, ${this.guilds.size} guild(s), ${this.archivedSessions.size} archived`);
        return;
      }
    }

    // 回退：从旧表加载（新表为空时）
    const sessions = this.sessionRepo.loadAllSessions();
    const guilds = this.guildRepo.loadAll();

    if (sessions.length === 0 && guilds.length === 0) {
      await this.migrateFromJson();
      const migratedSessions = this.sessionRepo.loadAllSessions();
      const migratedGuilds = this.guildRepo.loadAll();
      for (const s of migratedSessions) {
        this.sessions.set(this.channelKey(s.guildId, s.channelId), s);
      }
      for (const g of migratedGuilds) {
        this.guilds.set(g.guildId, g);
      }
    } else {
      for (const s of sessions) {
        this.sessions.set(this.channelKey(s.guildId, s.channelId), s);
      }
      for (const g of guilds) {
        this.guilds.set(g.guildId, g);
      }
    }

    const archived = this.sessionRepo.loadAllArchived();
    for (const a of archived) {
      this.archivedSessions.set(this.channelKey(a.guildId, a.channelId), a);
    }

    logger.info(`Loaded ${this.sessions.size} session(s), ${this.guilds.size} guild(s), ${this.archivedSessions.size} archived from SQLite (deprecated tables)`);
  }

  /**
   * 从新表重建内存 Map：
   * 每个 active channel 取最新的 active claude_session（通过 link 关联）
   * 返回成功重建的 session 数量
   */
  private _rebuildFromNewTables(channels: Channel[]): number {
    const activeChannels = channels.filter(c => c.status === 'active');
    if (activeChannels.length === 0) return 0;

    let count = 0;
    for (const ch of activeChannels) {
      // 查该 channel 最新活跃的 link → claude_session
      const activeLinks = this.linkRepo!.getActiveLinks(ch.id);
      const latestLink = activeLinks[activeLinks.length - 1]; // linked_at ASC，取最新

      // 无活跃 link 的 channel 仍需重建 Session（用于接收新消息），但不关联 claudeSessionId
      const claudeSessionId = latestLink?.claudeSessionId;  // CLI session_id
      const claudeUuid = latestLink?.claudeSessionUuid;

      const session: Session = {
        // 有 link 时用 link 的 UUID，否则使用稳定的 channelId 派生标识（不生成随机 UUID 以防孤儿数据）
        id: claudeUuid ?? ch.id,
        name: ch.name,
        channelId: ch.id,
        guildId: ch.guildId,
        claudeSessionId: claudeSessionId,
        cwd: ch.cwd,
        createdAt: ch.createdAt,
        lastMessage: ch.lastMessage,
        lastMessageAt: ch.lastMessageAt,
        model: latestLink?.model,
        messageCount: ch.messageCount,
        parentChannelId: ch.parentChannelId,
        worktreeBranch: ch.worktreeBranch,
      };

      this.sessions.set(this.channelKey(ch.guildId, ch.id), session);
      count++;
    }
    return count;
  }

  /**
   * 从旧版 discord-states.json 迁移数据到 SQLite（一次性操作）
   */
  private async migrateFromJson(): Promise<void> {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(__dirname, '../../data/discord-states.json');

    let raw: string;
    try {
      raw = readFileSync(jsonPath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info('No JSON state file found, starting fresh with SQLite');
        return;
      }
      logger.error('Failed to read JSON state file for migration:', err.message);
      return;
    }

    let data: {
      sessions?: Record<string, Session>;
      guilds?: Record<string, GuildState>;
      archivedSessions?: Record<string, ArchivedSession>;
    };
    try {
      data = JSON.parse(raw);
    } catch (err: any) {
      logger.error('Failed to parse JSON state file:', err.message);
      return;
    }

    let sessionCount = 0;
    let guildCount = 0;
    let archivedCount = 0;

    if (data.guilds && this.guildRepo) {
      for (const guild of Object.values(data.guilds)) {
        if (!guild.lastActivity) guild.lastActivity = Date.now();
        await this.guildRepo.save(guild);
        guildCount++;
      }
    }

    if (data.sessions && this.sessionRepo) {
      for (const session of Object.values(data.sessions)) {
        await this.sessionRepo.save(session);
        sessionCount++;
      }
    }

    if (data.archivedSessions && this.sessionRepo) {
      for (const archived of Object.values(data.archivedSessions)) {
        await this.sessionRepo.save(archived as Session);
        await this.sessionRepo.archive(
          archived.guildId,
          archived.channelId,
          archived.archivedBy,
          archived.archiveReason,
        );
        archivedCount++;
      }
    }

    logger.info(`Migrated from JSON: ${sessionCount} session(s), ${guildCount} guild(s), ${archivedCount} archived`);

    try {
      renameSync(jsonPath, jsonPath + '.bak');
      logger.info('Renamed discord-states.json → discord-states.json.bak');
    } catch (err: any) {
      logger.warn('Failed to rename JSON file:', err.message);
    }
  }

  async flush(): Promise<void> {
    // SQLite writes are immediate, nothing to flush
  }

  // ========== 持久化辅助 ==========

  private persistSession(guildId: string, channelId: string): void {
    const session = this.sessions.get(this.channelKey(guildId, channelId));
    if (!session) return;

    // 写入旧表（兼容，待旧表完全废弃后删除）
    if (this.sessionRepo) {
      this.sessionRepo.save(session);
    }

    // 双写到新表
    if (this.channelRepo && this.claudeSessionRepo) {
      const channel: Channel = {
        id: session.channelId,
        guildId: session.guildId,
        name: session.name,
        cwd: session.cwd,
        worktreeBranch: session.worktreeBranch,
        parentChannelId: session.parentChannelId,
        status: 'active',
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        lastMessage: session.lastMessage,
        lastMessageAt: session.lastMessageAt,
      };
      this.channelRepo.save(channel);

      // 写入 claude_sessions 表（仅在已有 claudeSessionId 时写入，避免产生空壳记录）
      if (session.claudeSessionId) {
        const ctx = this.db ? resolveSessionContext(this.db, session.channelId) : null;
        const claudeSession: ClaudeSession = {
          id: session.id,
          claudeSessionId: session.claudeSessionId,
          prevClaudeSessionId: session.prevClaudeSessionId,
          channelId: session.channelId,
          model: session.model,
          planMode: session.planMode ?? false,
          status: 'active',
          createdAt: session.createdAt,
          purpose: 'channel',
          taskId: ctx?.taskId ?? undefined,
          goalId: ctx?.goalId ?? undefined,
          cwd: ctx?.cwd ?? session.cwd,
          gitBranch: ctx?.gitBranch ?? session.worktreeBranch,
        };
        this.claudeSessionRepo.save(claudeSession);
      }
    }
  }

  private persistGuild(guildId: string): void {
    if (!this.guildRepo) return;
    const guild = this.guilds.get(guildId);
    if (guild) {
      this.guildRepo.save(guild);
    }
  }

  // ========== Session CRUD ==========

  getOrCreateSession(guildId: string, channelId: string, defaults: { name: string; cwd: string }): Session {
    const key = this.channelKey(guildId, channelId);
    if (!this.sessions.has(key)) {
      const guildModel = this.getGuildDefaultModel(guildId);
      const session: Session = {
        id: randomUUID(),
        name: defaults.name,
        channelId,
        guildId,
        cwd: defaults.cwd,
        createdAt: Date.now(),
        model: guildModel,
        messageCount: 0,
      };
      this.sessions.set(key, session);
      this.persistSession(guildId, channelId);

      if (this.channelRepo) {
        const channel: Channel = {
          id: channelId,
          guildId,
          name: defaults.name,
          cwd: defaults.cwd,
          status: 'active',
          messageCount: 0,
          createdAt: Date.now(),
        };
        this.channelRepo.save(channel);
      }
    }
    return this.sessions.get(key)!;
  }

  getSession(guildId: string, channelId: string): Session | undefined {
    return this.sessions.get(this.channelKey(guildId, channelId));
  }

  getAllSessions(guildId: string): Session[] {
    const result: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId) result.push(session);
    }
    return result;
  }

  /**
   * 查找持有指定 claudeSessionId（CLI session_id）的 channel
   * 优先查 link repo（新表），回退到内存 Map
   */
  findSessionHolder(guildId: string, claudeSessionId: string): { channelId: string; name: string } | null {
    // 通过 link repo 查（需要先找到对应的 claude_sessions.id UUID）
    if (this.claudeSessionRepo && this.linkRepo) {
      const cs = this.claudeSessionRepo.findByClaudeSessionId(claudeSessionId);
      if (cs) {
        const link = this.linkRepo.getActiveBySession(cs.id);
        if (link) {
          const session = this.sessions.get(this.channelKey(guildId, link.channelId));
          if (session) return { channelId: link.channelId, name: session.name };
          // session 不在内存，构造最小信息
          return { channelId: link.channelId, name: link.channelId };
        }
      }
    }

    // 回退：内存 Map 扫描
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.claudeSessionId === claudeSessionId) {
        return { channelId: session.channelId, name: session.name };
      }
    }
    return null;
  }

  // ========== Session 操作 ==========

  updateSessionMessage(guildId: string, channelId: string, text: string, role: 'user' | 'assistant'): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;

    session.messageCount++;

    if (role === 'assistant') {
      session.lastMessage = text.slice(0, 500);
      session.lastMessageAt = Date.now();
    }

    if (this.sessionRepo) {
      this.persistSession(guildId, channelId);
    }
  }

  /**
   * 设置 claudeSessionId（CLI session_id），同时维护 link
   * @param claudeUuid claude_sessions.id（UUID），用于 link 操作；传 undefined 时不操作 link
   */
  setSessionClaudeId(guildId: string, channelId: string, claudeSessionId: string, claudeUuid?: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;
    // 同步 session.id 与 link UUID（隐性约定：session.id === link.claudeSessionUuid）
    // 必须在 persistSession() 之前赋值，否则 claude_sessions 表写入的 id 与 link 不一致
    if (claudeUuid) {
      session.id = claudeUuid;
    }

    // persistSession（写 claude_sessions）与 createLink（写 channel_session_links）必须原子完成：
    // 若 save() 成功但 createLink 失败，link 表中不会有该 session 的记录，导致 reply 路由永远失败。
    if (claudeUuid && this.linkRepo && this.db) {
      this.db.transaction(() => {
        this.persistSession(guildId, channelId);
        const existingLinks = this.linkRepo!.getActiveLinks(channelId);
        const alreadyLinked = existingLinks.some(l => l.claudeSessionUuid === claudeUuid);
        if (!alreadyLinked) {
          this.linkRepo!.createLink(channelId, claudeUuid);
        }
      })();
    } else {
      // 降级：无 db 引用（测试环境）或无 linkRepo，各自独立写入
      this.persistSession(guildId, channelId);
      if (claudeUuid && this.linkRepo) {
        const existingLinks = this.linkRepo.getActiveLinks(channelId);
        const alreadyLinked = existingLinks.some(l => l.claudeSessionUuid === claudeUuid);
        if (!alreadyLinked) {
          this.linkRepo.createLink(channelId, claudeUuid);
        }
      }
    }
  }

  setSessionCwd(guildId: string, channelId: string, cwd: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.cwd = cwd;
    this.persistSession(guildId, channelId);
  }

  clearSessionClaudeId(guildId: string, channelId: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;

    // unlink 当前活跃 link
    // session.id 经 setSessionClaudeId() 已与 link.claudeSessionUuid 同步，直接使用
    if (this.linkRepo && session.claudeSessionId) {
      this.linkRepo.unlinkSession(channelId, session.id);
    }

    session.claudeSessionId = undefined;
    session.prevClaudeSessionId = undefined;
    this.persistSession(guildId, channelId);
  }

  rewindSession(guildId: string, channelId: string): { success: boolean; reason?: string; prevId?: string } {
    const session = this.getSession(guildId, channelId);
    if (!session) return { success: false, reason: '会话不存在' };
    if (!session.prevClaudeSessionId) return { success: false, reason: '没有可撤销的对话轮次' };

    const prevId = session.prevClaudeSessionId;
    session.claudeSessionId = prevId;
    session.prevClaudeSessionId = undefined;
    session.messageCount = Math.max(0, session.messageCount - 2);

    // 注意：rewind 不更新 channel_session_links 表。
    // link 仍指向 rewind 前的 session，reply 路由会继续指向最后一条 Done 消息。
    // 在单 link 场景下无影响；多 link 场景下，rewind 后用户需直接发消息（无需 reply 路由）。
    this.persistSession(guildId, channelId);
    return { success: true, prevId };
  }

  setSessionModel(guildId: string, channelId: string, model: string | undefined): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.model = model;
    this.persistSession(guildId, channelId);
  }

  setSessionPlanMode(guildId: string, channelId: string, planMode: boolean): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.planMode = planMode;
    this.persistSession(guildId, channelId);
  }

  // ========== Guild ==========

  getGuildDefaultCwd(guildId: string): string {
    return this.guilds.get(guildId)?.defaultCwd || this.defaultWorkDir;
  }

  getGuildDefaultModel(guildId: string): string | undefined {
    return this.guilds.get(guildId)?.defaultModel;
  }

  setGuildDefaultModel(guildId: string, model: string | undefined): void {
    const guild = this.guilds.get(guildId);
    if (guild) {
      guild.defaultModel = model;
      guild.lastActivity = Date.now();
    } else {
      this.guilds.set(guildId, { guildId, defaultCwd: this.defaultWorkDir, defaultModel: model, lastActivity: Date.now() });
    }
    this.persistGuild(guildId);
  }

  setGuildDefaultCwd(guildId: string, cwd: string): void {
    const guild = this.guilds.get(guildId);
    if (guild) {
      guild.defaultCwd = cwd;
      guild.lastActivity = Date.now();
    } else {
      this.guilds.set(guildId, { guildId, defaultCwd: cwd, lastActivity: Date.now() });
    }
    this.persistGuild(guildId);
  }

  // ========== Link 管理（前台 session 专用）==========

  /**
   * 获取 channel 所有活跃 link（用于消息标头判断和 reply 路由）
   */
  getActiveLinks(channelId: string) {
    return this.linkRepo?.getActiveLinks(channelId) ?? [];
  }

  /**
   * 通过 Discord 消息 ID 反查 claudeSessionUuid（reply 路由）
   */
  findLinkByDiscordMessageId(discordMessageId: string) {
    return this.linkRepo?.getByDiscordMessageId(discordMessageId) ?? null;
  }

  /**
   * 更新 link 的最新 Discord 消息 ID（消息发出后调用）
   */
  updateLinkLastMessageId(channelId: string, claudeSessionUuid: string, discordMessageId: string): void {
    this.linkRepo?.updateLastMessageId(channelId, claudeSessionUuid, discordMessageId);
  }

  /**
   * 创建 link（前台 session 创建时）
   */
  createLink(channelId: string, claudeSessionUuid: string): void {
    this.linkRepo?.createLink(channelId, claudeSessionUuid);
  }

  /**
   * 将 channel 下所有活跃 link 全部 unlink，然后创建新 link（attach 操作）
   */
  transferLink(channelId: string, newClaudeSessionUuid: string): void {
    if (!this.linkRepo) return;
    if (this.db) {
      this.db.transaction(() => {
        this.linkRepo!.unlinkAllForChannel(channelId);
        this.linkRepo!.createLink(channelId, newClaudeSessionUuid);
      })();
    } else {
      this.linkRepo.unlinkAllForChannel(channelId);
      this.linkRepo.createLink(channelId, newClaudeSessionUuid);
    }
  }

  /**
   * attach 操作：将指定 CLI session_id 关联到 channel
   * 自动处理 link 转移（从旧 channel unlink → link 到新 channel）
   * 返回旧持有者信息（如果有）
   */
  attachSession(
    guildId: string,
    channelId: string,
    targetCliSessionId: string,
  ): { success: boolean; prevHolder?: { channelId: string; name: string } } {
    // 找到对应的 claude_sessions UUID
    const cs = this.claudeSessionRepo?.findByClaudeSessionId(targetCliSessionId);
    const targetUuid = cs?.id;

    // 找到旧持有者（内存 Map 或 link）
    const prevHolder = this.findSessionHolder(guildId, targetCliSessionId) ?? undefined;

    // 将所有 DB 写操作包裹在事务中（better-sqlite3 同步事务）
    if (this.db) {
      const doDbWrites = this.db.transaction(() => {
        if (prevHolder && prevHolder.channelId !== channelId) {
          if (targetUuid && this.linkRepo) {
            this.linkRepo.unlinkSession(prevHolder.channelId, targetUuid);
          }
        }
        if (targetUuid && this.linkRepo) {
          const alreadyLinked = this.linkRepo.getActiveLinks(channelId).some(l => l.claudeSessionUuid === targetUuid);
          if (!alreadyLinked) {
            this.linkRepo.createLink(channelId, targetUuid);
          }
        }
      });
      doDbWrites();
    } else {
      // 无 db（测试环境），降级执行
      if (prevHolder && prevHolder.channelId !== channelId && targetUuid && this.linkRepo) {
        this.linkRepo.unlinkSession(prevHolder.channelId, targetUuid);
      }
      if (targetUuid && this.linkRepo) {
        const alreadyLinked = this.linkRepo.getActiveLinks(channelId).some(l => l.claudeSessionUuid === targetUuid);
        if (!alreadyLinked) {
          this.linkRepo.createLink(channelId, targetUuid);
        }
      }
    }

    // 更新内存 Map（事务提交后再更新，保证 DB 写成功）
    if (prevHolder && prevHolder.channelId !== channelId) {
      const prevSession = this.getSession(guildId, prevHolder.channelId);
      if (prevSession && prevSession.claudeSessionId === targetCliSessionId) {
        prevSession.claudeSessionId = undefined;
        prevSession.prevClaudeSessionId = undefined;
        this.persistSession(guildId, prevHolder.channelId);
      }
    }

    const session = this.getSession(guildId, channelId);
    if (session) {
      if (session.claudeSessionId && session.claudeSessionId !== targetCliSessionId) {
        session.prevClaudeSessionId = session.claudeSessionId;
      }
      session.claudeSessionId = targetCliSessionId;
      // 同步 session.id 与 attach 目标的 claude_sessions UUID，
      // 保证后续 setSessionClaudeId() 使用正确的 UUID 维护 link 表
      if (targetUuid) {
        session.id = targetUuid;
      }
      this.persistSession(guildId, channelId);
    }

    return { success: true, prevHolder };
  }

  // ========== 清理 ==========

  cleanup(): void {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 天

    for (const [key, session] of this.sessions.entries()) {
      const lastActive = session.lastMessageAt || session.createdAt;
      if (now - lastActive > maxAge) {
        this.sessions.delete(key);
        if (this.sessionRepo) {
          this.sessionRepo.delete(session.guildId, session.channelId);
        }
      }
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // ========== Thread 归档管理 ==========

  archiveSession(guildId: string, channelId: string, userId?: string, reason?: string): boolean {
    const key = this.channelKey(guildId, channelId);
    const session = this.sessions.get(key);

    if (!session) return false;

    const archivedSession: ArchivedSession = {
      ...session,
      archivedAt: Date.now(),
      archivedBy: userId,
      archiveReason: reason,
    };

    this.archivedSessions.set(key, archivedSession);
    this.sessions.delete(key);
    this.clearChildParentRefs(guildId, channelId);

    logger.info(`Archived session: ${session.name} (channel=${channelId}, guild=${guildId})`);

    if (this.sessionRepo) {
      this.sessionRepo.archive(guildId, channelId, userId, reason);
    }

    if (this.channelRepo) {
      this.channelRepo.archive(channelId, userId, reason);
    }

    // unlink 所有活跃 link，并关闭 claude_sessions
    if (this.linkRepo) {
      this.linkRepo.unlinkAllForChannel(channelId);
    }
    if (this.claudeSessionRepo) {
      const activeSession = this.claudeSessionRepo.getActiveByChannel(channelId);
      if (activeSession) {
        this.claudeSessionRepo.close(activeSession.id);
      }
    }

    return true;
  }

  deleteSession(guildId: string, channelId: string): boolean {
    const key = this.channelKey(guildId, channelId);
    const existed = this.sessions.has(key);

    if (existed) {
      this.sessions.delete(key);
      this.clearChildParentRefs(guildId, channelId);
      if (this.sessionRepo) {
        this.sessionRepo.delete(guildId, channelId);
      }
      if (this.linkRepo) {
        this.linkRepo.unlinkAllForChannel(channelId);
      }
    }

    return existed;
  }

  private clearChildParentRefs(guildId: string, parentChannelId: string): void {
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.parentChannelId === parentChannelId) {
        session.parentChannelId = undefined;
      }
    }
    if (this.sessionRepo) {
      this.sessionRepo.clearParentRefs(guildId, parentChannelId);
    }
  }

  getArchivedSession(guildId: string, channelId: string): ArchivedSession | undefined {
    return this.archivedSessions.get(this.channelKey(guildId, channelId));
  }

  restoreArchivedSession(guildId: string, channelId: string): boolean {
    const key = this.channelKey(guildId, channelId);
    const archived = this.archivedSessions.get(key);

    if (!archived) return false;

    const { archivedAt, archivedBy, archiveReason, ...session } = archived;

    this.sessions.set(key, session as Session);
    this.archivedSessions.delete(key);

    if (this.sessionRepo) {
      this.sessionRepo.restore(guildId, channelId);
    }
    return true;
  }

  getAllArchivedSessions(guildId: string): ArchivedSession[] {
    const result: ArchivedSession[] = [];
    for (const archived of this.archivedSessions.values()) {
      if (archived.guildId === guildId) {
        result.push(archived);
      }
    }
    return result;
  }

  getOccupiedWorkDirs(guildId: string): Set<string> {
    const paths = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId) {
        paths.add(session.cwd);
      }
    }
    return paths;
  }

  setSessionForkInfo(guildId: string, channelId: string, parentChannelId: string, worktreeBranch: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.parentChannelId = parentChannelId;
    session.worktreeBranch = worktreeBranch;
    this.persistSession(guildId, channelId);
  }

  getRootSession(guildId: string, channelId: string): Session | undefined {
    let session = this.getSession(guildId, channelId);
    if (!session) return undefined;
    while (session.parentChannelId != null) {
      const parent = this.getSession(guildId, session.parentChannelId);
      if (!parent) break;
      session = parent;
    }
    return session;
  }

  clearSessionParent(guildId: string, channelId: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.parentChannelId = undefined;
    this.persistSession(guildId, channelId);
  }

  getChildSessions(guildId: string, parentChannelId: string): Session[] {
    const result: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.parentChannelId === parentChannelId) {
        result.push(session);
      }
    }
    return result;
  }

  setSessionName(guildId: string, channelId: string, name: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.name = name;
    this.persistSession(guildId, channelId);
  }

  // ========== Session 状态追踪（hooks 事件处理）==========

  setWaitingMessageId(channelId: string, msgId: string): void {
    const tracking = this.sessionTracking.get(channelId) || {};
    tracking.waitingMessageId = msgId;
    this.sessionTracking.set(channelId, tracking);
  }

  getWaitingMessageId(channelId: string): string | undefined {
    return this.sessionTracking.get(channelId)?.waitingMessageId;
  }

  setWaitingTimer(channelId: string, timer: NodeJS.Timeout): void {
    const tracking = this.sessionTracking.get(channelId) || {};
    if (tracking.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
    }
    tracking.waitingTimer = timer;
    this.sessionTracking.set(channelId, tracking);
  }

  cancelWaitingMessage(channelId: string): void {
    const tracking = this.sessionTracking.get(channelId);
    if (!tracking) return;
    if (tracking.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
      tracking.waitingTimer = undefined;
    }
    tracking.waitingMessageId = undefined;
    this.sessionTracking.set(channelId, tracking);
  }

  clearSessionTracking(channelId: string): void {
    const tracking = this.sessionTracking.get(channelId);
    if (tracking?.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
    }
    this.sessionTracking.delete(channelId);
  }
}
