/**
 * 状态管理（Guild + Category/Channels 模式）
 * 每个 Text Channel 对应一个独立 Session，不同 channel 并行无干扰
 * ID 全部使用 string (Discord snowflake)
 *
 * 持久化后端：SQLite（通过 ChannelRepository + GuildRepository + ClaudeSessionRepository）
 * 内存 Map 作为读缓存，写操作同步写入 SQLite（better-sqlite3 是同步的）
 *
 * Link 体系：
 *   channel : claude_session = 1:N（通过 channel_session_links 表管理）
 *   - 前台 session（用户交互）必须有 link，否则无法向 channel 发消息
 *   - 后台 session（background task）不创建 link
 *   - attach 操作 = 转移 link（旧 session unlink，新 session link）
 */

import { Session, GuildState, ArchivedSession, Channel, ClaudeSession } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { GuildRepository } from '../db/repo/guild-repo.js';
import type { ChannelRepository } from '../db/repo/channel-repo.js';
import type { ClaudeSessionRepository } from '../db/repo/claude-session-repo.js';
import type Database from 'better-sqlite3';
import { resolveSessionContext } from '../sync/session-context.js';
import type { ChannelSessionLinkRepository } from '../db/repo/channel-session-link-repo.js';

// Session 状态追踪（用于 hooks 事件处理）
interface SessionTracking {
  waitingMessageId?: string;      // 等待消息 ID（用于删除）
  waitingTimer?: NodeJS.Timeout;  // 等待消息定时器（用于取消）
  doneSentAt?: number;            // Done 消息发送时间戳（用于 hook 去重）
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
    if (!this.channelRepo || !this.guildRepo) {
      logger.warn('StateManager: No repositories provided, running without persistence');
      return;
    }

    const channels = this.channelRepo.loadAll();
    this._rebuildFromNewTables(channels.filter(c => c.status === 'active' && !c.hidden));

    // 从 channels (status='archived') 重建 archivedSessions（hidden channel 不需要恢复）
    for (const ch of channels.filter(c => c.status === 'archived' && !c.hidden)) {
      const archived: ArchivedSession = {
        name: ch.name,
        channelId: ch.id,
        guildId: ch.guildId,
        cwd: ch.cwd,
        createdAt: ch.createdAt,
        lastMessage: ch.lastMessage,
        lastMessageAt: ch.lastMessageAt,
        messageCount: ch.messageCount,
        parentChannelId: ch.parentChannelId,
        worktreeBranch: ch.worktreeBranch,
        archivedAt: ch.archivedAt ?? Date.now(),
        archivedBy: ch.archivedBy,
        archiveReason: ch.archiveReason,
      };
      this.archivedSessions.set(this.channelKey(ch.guildId, ch.id), archived);
    }

    const guilds = this.guildRepo.loadAll();
    for (const g of guilds) {
      this.guilds.set(g.guildId, g);
    }

    logger.info(`Loaded ${this.sessions.size} session(s), ${this.guilds.size} guild(s), ${this.archivedSessions.size} archived`);
  }

  /**
   * 从新表重建内存 Map：
   * 每个 active channel 取最新的 active claude_session（通过 link 关联）
   * 返回成功重建的 session 数量
   */
  private _rebuildFromNewTables(channels: Channel[]): number {
    if (channels.length === 0) return 0;

    let count = 0;
    for (const ch of channels) {
      // 查该 channel 最新活跃的 link → claude_session
      const activeLinks = this.linkRepo?.getActiveLinks(ch.id) ?? [];
      const latestLink = activeLinks[activeLinks.length - 1]; // linked_at ASC，取最新

      // 无活跃 link 的 channel 仍需重建 Session（用于接收新消息），但不关联 claudeSessionId
      const claudeSessionId = latestLink?.claudeSessionId;  // CLI session_id

      const session: Session = {
        name: ch.name,
        channelId: ch.id,
        guildId: ch.guildId,
        claudeSessionId: claudeSessionId,
        cwd: ch.cwd,
        createdAt: ch.createdAt,
        lastMessage: ch.lastMessage,
        lastMessageAt: ch.lastMessageAt,
        model: latestLink?.model,
        effort: latestLink?.effort,
        messageCount: ch.messageCount,
        parentChannelId: ch.parentChannelId,
        worktreeBranch: ch.worktreeBranch,
      };

      this.sessions.set(this.channelKey(ch.guildId, ch.id), session);
      count++;
    }
    return count;
  }

  async flush(): Promise<void> {
    // SQLite writes are immediate, nothing to flush
  }

  // ========== 持久化辅助 ==========

  private persistSession(guildId: string, channelId: string): void {
    const session = this.sessions.get(this.channelKey(guildId, channelId));
    if (!session) return;

    const isHidden = session.hidden ?? false;

    if (this.channelRepo && this.claudeSessionRepo) {
      // hidden session 也需要写入 channels 表，以满足 claude_sessions.channel_id 的 FK 约束
      // hidden=1 标记区分虚拟 channel 与真实 Discord channel，UI 层过滤 hidden=0 即可
      {
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
          hidden: isHidden,
        };
        this.channelRepo.save(channel);
      }

      // 写入 claude_sessions 表（仅在已有 claudeSessionId 时写入，避免产生空壳记录）
      if (session.claudeSessionId) {
        const ctx = (!isHidden && this.db) ? resolveSessionContext(this.db, session.channelId) : null;
        // 保留已有的 status，避免覆盖 hook 事件设置的状态（idle/waiting/closed）
        // 新 session（首次写入）默认为 'active'
        const existingSession = this.claudeSessionRepo.get(session.claudeSessionId);
        const claudeSession: ClaudeSession = {
          claudeSessionId: session.claudeSessionId,
          prevClaudeSessionId: session.prevClaudeSessionId,
          channelId: session.channelId,
          model: session.model,
          effort: session.effort,
          planMode: session.planMode ?? false,
          status: existingSession?.status ?? 'active',
          createdAt: session.createdAt,
          purpose: 'channel',
          taskId: ctx?.taskId ?? undefined,
          goalId: ctx?.goalId ?? undefined,
          cwd: ctx?.cwd ?? session.cwd,
          gitBranch: ctx?.gitBranch ?? session.worktreeBranch,
          hidden: isHidden,
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

  getOrCreateSession(guildId: string, channelId: string, defaults: { name: string; cwd: string; hidden?: boolean }): Session {
    const key = this.channelKey(guildId, channelId);
    if (!this.sessions.has(key)) {
      const guildModel = this.getGuildDefaultModel(guildId);
      const session: Session = {
        name: defaults.name,
        channelId,
        guildId,
        cwd: defaults.cwd,
        createdAt: Date.now(),
        model: guildModel,
        messageCount: 0,
        hidden: defaults.hidden ?? false,
      };
      this.sessions.set(key, session);
      this.persistSession(guildId, channelId);
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
    // 通过 link repo 直接查 claudeSessionId
    if (this.linkRepo) {
      const link = this.linkRepo.getActiveBySession(claudeSessionId);
      if (link) {
        const session = this.sessions.get(this.channelKey(guildId, link.channelId));
        if (session) return { channelId: link.channelId, name: session.name };
        // session 不在内存，构造最小信息
        return { channelId: link.channelId, name: link.channelId };
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

    this.persistSession(guildId, channelId);
  }

  /**
   * 设置 claudeSessionId（CLI session_id），同时维护 link
   */
  setSessionClaudeId(guildId: string, channelId: string, claudeSessionId: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;

    // hidden session 无对应 channels 行，跳过 channel_session_links（有 FK 约束）
    const isHidden = session.hidden ?? false;

    // persistSession（写 claude_sessions）与 createLink（写 channel_session_links）必须原子完成
    if (this.linkRepo && this.db) {
      try {
        this.db.transaction(() => {
          this.persistSession(guildId, channelId);
          if (!isHidden) {
            const existingLinks = this.linkRepo!.getActiveLinks(channelId);
            const alreadyLinked = existingLinks.some(l => l.claudeSessionId === claudeSessionId);
            if (!alreadyLinked) {
              this.linkRepo!.createLink(channelId, claudeSessionId);
            }
          }
        })();
      } catch (err: any) {
        logger.error(`[setSessionClaudeId] transaction failed (cli=${claudeSessionId.slice(0, 8)}):`, err);
        this.persistSession(guildId, channelId);
      }
    } else {
      this.persistSession(guildId, channelId);
      if (this.linkRepo && !isHidden) {
        const existingLinks = this.linkRepo.getActiveLinks(channelId);
        const alreadyLinked = existingLinks.some(l => l.claudeSessionId === claudeSessionId);
        if (!alreadyLinked) {
          this.linkRepo.createLink(channelId, claudeSessionId);
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
    if (this.linkRepo && session.claudeSessionId) {
      this.linkRepo.unlinkSession(channelId, session.claudeSessionId);
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

  setSessionEffort(guildId: string, channelId: string, effort: string | undefined): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.effort = effort;
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
   * 通过 Discord 消息 ID 反查 link（reply 路由）
   */
  findLinkByDiscordMessageId(discordMessageId: string) {
    return this.linkRepo?.getByDiscordMessageId(discordMessageId) ?? null;
  }

  /**
   * 更新 link 的最新 Discord 消息 ID（消息发出后调用）
   */
  updateLinkLastMessageId(channelId: string, claudeSessionId: string, discordMessageId: string): void {
    this.linkRepo?.updateLastMessageId(channelId, claudeSessionId, discordMessageId);
  }

  /**
   * 创建 link（前台 session 创建时）
   */
  createLink(channelId: string, claudeSessionId: string): void {
    this.linkRepo?.createLink(channelId, claudeSessionId);
  }

  /**
   * 软删除指定 link（/sessions cleanup 使用）
   */
  unlinkSession(channelId: string, claudeSessionId: string): void {
    this.linkRepo?.unlinkSession(channelId, claudeSessionId);
  }

  /**
   * 将 channel 下所有活跃 link 全部 unlink，然后创建新 link（attach 操作）
   */
  transferLink(channelId: string, newClaudeSessionId: string): void {
    if (!this.linkRepo) return;
    if (this.db) {
      this.db.transaction(() => {
        this.linkRepo!.unlinkAllForChannel(channelId);
        this.linkRepo!.createLink(channelId, newClaudeSessionId);
      })();
    } else {
      this.linkRepo.unlinkAllForChannel(channelId);
      this.linkRepo.createLink(channelId, newClaudeSessionId);
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
    // 1. 找到旧持有者（在修改内存前查找）
    const prevHolder = this.findSessionHolder(guildId, targetCliSessionId) ?? undefined;

    // 2. 更新内存 Session
    const session = this.getSession(guildId, channelId);
    if (!session) return { success: false };

    if (session.claudeSessionId && session.claudeSessionId !== targetCliSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = targetCliSessionId;

    // 3. 事务：unlink + persistSession + createLink
    //    persistSession 必须在 createLink 之前，确保 claude_sessions 记录存在（FK 约束）
    if (this.db && this.linkRepo) {
      try {
        this.db.transaction(() => {
          // 3a. 从旧持有者 unlink
          if (prevHolder && prevHolder.channelId !== channelId) {
            this.linkRepo!.unlinkSession(prevHolder.channelId, targetCliSessionId);
          }
          // 3b. 清理当前 channel 的所有旧 link
          this.linkRepo!.unlinkAllForChannel(channelId);
          // 3c. 写入 claude_sessions 记录（如果不存在则创建）
          this.persistSession(guildId, channelId);
          // 3d. 创建 link（此时 claude_sessions 记录已存在，FK 满足）
          this.linkRepo!.createLink(channelId, targetCliSessionId);
        })();
      } catch (err: any) {
        logger.error('[attachSession] transaction failed:', err);
        this.persistSession(guildId, channelId);
      }
    } else if (this.linkRepo) {
      this.persistSession(guildId, channelId);
      this.linkRepo.unlinkAllForChannel(channelId);
      this.linkRepo.createLink(channelId, targetCliSessionId);
    } else {
      this.persistSession(guildId, channelId);
    }

    // 4. 清理旧持有者的内存状态
    if (prevHolder && prevHolder.channelId !== channelId) {
      const prevSession = this.getSession(guildId, prevHolder.channelId);
      if (prevSession && prevSession.claudeSessionId === targetCliSessionId) {
        prevSession.claudeSessionId = undefined;
        prevSession.prevClaudeSessionId = undefined;
        this.persistSession(guildId, prevHolder.channelId);
      }
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
        if (this.channelRepo) {
          this.channelRepo.archive(session.channelId);
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
        this.claudeSessionRepo.close(activeSession.claudeSessionId);
      }
    }

    return true;
  }

  /**
   * 关闭 channel 当前活跃的 claude_session（标记为 closed）。
   * 用于 AUTH_ERROR 等异常退出场景：CLI 崩溃时 Stop hook 不会触发，
   * session 会停留在 'active'，导致 checkOrphanedTasks 误认为 Claude 仍在工作而跳过轻推。
   */
  closeActiveSessionForChannel(channelId: string): void {
    if (!this.claudeSessionRepo) return;
    const activeSession = this.claudeSessionRepo.getActiveByChannel(channelId);
    if (activeSession) {
      this.claudeSessionRepo.close(activeSession.claudeSessionId);
    }
  }

  deleteSession(guildId: string, channelId: string): boolean {
    const key = this.channelKey(guildId, channelId);
    const existed = this.sessions.has(key);

    if (existed) {
      this.sessions.delete(key);
      this.clearChildParentRefs(guildId, channelId);
      if (this.channelRepo) {
        this.channelRepo.archive(channelId).catch(() => {});
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
    if (this.channelRepo) {
      this.channelRepo.clearParentRefs(guildId, parentChannelId);
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

    if (this.channelRepo) {
      this.channelRepo.restore(channelId);
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

  setSessionForkInfo(guildId: string, channelId: string, parentChannelId: string, worktreeBranch: string | undefined): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    session.parentChannelId = parentChannelId;
    if (worktreeBranch !== undefined) {
      session.worktreeBranch = worktreeBranch;
    }
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

  /** 查询 channel 最新 Claude session 的状态（用于 check-in 监工） */
  getChannelSessionStatus(channelId: string): 'active' | 'waiting' | 'idle' | 'closed' | null {
    if (!this.claudeSessionRepo) return null;
    const sessions = this.claudeSessionRepo.getByChannel(channelId);
    if (sessions.length === 0) return null;
    // getByChannel 按 created_at DESC 排序，第一条是最新的
    return sessions[0].status as 'active' | 'waiting' | 'idle' | 'closed';
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
    if (!tracking) return;
    if (tracking.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
    }
    // 保留 doneSentAt（hook setTimeout 可能仍在等待检查）
    if (tracking.doneSentAt) {
      this.sessionTracking.set(channelId, { doneSentAt: tracking.doneSentAt });
    } else {
      this.sessionTracking.delete(channelId);
    }
  }

  // ========== Done 消息去重（handler vs hook）==========

  setDoneSentAt(channelId: string): void {
    const tracking = this.sessionTracking.get(channelId) || {};
    tracking.doneSentAt = Date.now();
    this.sessionTracking.set(channelId, tracking);
  }

  getDoneSentAt(channelId: string): number | undefined {
    return this.sessionTracking.get(channelId)?.doneSentAt;
  }

  clearDoneSentAt(channelId: string): void {
    const tracking = this.sessionTracking.get(channelId);
    if (tracking) {
      tracking.doneSentAt = undefined;
    }
  }
}
