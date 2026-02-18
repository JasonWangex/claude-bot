/**
 * 状态管理（Guild + Category/Channels 模式）
 * 每个 Text Channel 对应一个独立 Session，不同 channel 并行无干扰
 * ID 全部使用 string (Discord snowflake)
 *
 * 持久化后端：SQLite（通过 SessionRepository + GuildRepository）
 * 内存 Map 作为读缓存，写操作同步写入 SQLite（better-sqlite3 是同步的）
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
  ) {
    this.defaultWorkDir = defaultWorkDir;
  }

  private channelKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  // ========== 加载 ==========

  async load(): Promise<void> {
    if (this.sessionRepo && this.guildRepo) {
      // 先尝试从 SQLite 加载
      const sessions = this.sessionRepo.loadAllSessions();
      const guilds = this.guildRepo.loadAll();

      // 如果 SQLite 为空，尝试从旧 JSON 文件迁移
      if (sessions.length === 0 && guilds.length === 0) {
        await this.migrateFromJson();
        // 迁移后重新加载
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

      // 如果新表存在，也加载新表数据（优先使用新表）
      if (this.channelRepo && this.claudeSessionRepo) {
        const channels = this.channelRepo.loadAll();
        const claudeSessions = this.claudeSessionRepo.loadAll();
        logger.info(`Loaded ${channels.length} channels, ${claudeSessions.length} claude sessions from new tables`);
        // TODO: 将来可以用新表数据覆盖旧表数据，现阶段先共存
      }

      logger.info(`Loaded ${this.sessions.size} session(s), ${this.guilds.size} guild(s), ${this.archivedSessions.size} archived from SQLite`);
      return;
    }

    // 无 repo 时不加载
    logger.warn('StateManager: No repositories provided, running without persistence');
  }

  /**
   * 从旧版 discord-states.json 迁移数据到 SQLite（一次性操作）
   * 迁移成功后将 JSON 文件重命名为 .bak
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

    // 迁移 guilds
    if (data.guilds && this.guildRepo) {
      for (const guild of Object.values(data.guilds)) {
        // JSON 中可能缺少 lastActivity，补上默认值
        if (!guild.lastActivity) guild.lastActivity = Date.now();
        await this.guildRepo.save(guild);
        guildCount++;
      }
    }

    // 迁移 sessions
    if (data.sessions && this.sessionRepo) {
      for (const session of Object.values(data.sessions)) {
        await this.sessionRepo.save(session);
        sessionCount++;
      }
    }

    // 迁移 archived sessions
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

    // 重命名为 .bak
    try {
      renameSync(jsonPath, jsonPath + '.bak');
      logger.info('Renamed discord-states.json → discord-states.json.bak');
    } catch (err: any) {
      logger.warn('Failed to rename JSON file:', err.message);
    }
  }

  /**
   * 刷新到磁盘。SQLite 模式下为 no-op（写入是即时的）。
   */
  async flush(): Promise<void> {
    // SQLite writes are immediate, nothing to flush
  }

  // ========== 持久化辅助 ==========

  private persistSession(guildId: string, channelId: string): void {
    const session = this.sessions.get(this.channelKey(guildId, channelId));
    if (!session) return;

    // 写入旧表（兼容）
    if (this.sessionRepo) {
      this.sessionRepo.save(session);
    }

    // 双写到新表
    if (this.channelRepo && this.claudeSessionRepo) {
      // 写入 channels 表
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

      // 写入 claude_sessions 表（仅当 claudeSessionId 存在时，避免空壳记录）
      if (session.claudeSessionId) {
        const claudeSession: ClaudeSession = {
          id: session.id,
          claudeSessionId: session.claudeSessionId,
          prevClaudeSessionId: session.prevClaudeSessionId,
          channelId: session.channelId,
          model: session.model,
          planMode: session.planMode ?? false,
          status: 'active',
          createdAt: session.createdAt,
          purpose: 'channel',  // 默认为 channel 用途
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

      // 额外：立即创建 Channel 记录到新表
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
   * 查找持有指定 claudeSessionId 的 session（同 guild 内）
   */
  findSessionHolder(guildId: string, claudeSessionId: string): { channelId: string; name: string } | null {
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

    // 增加消息计数
    session.messageCount++;

    if (role === 'assistant') {
      session.lastMessage = text.slice(0, 500);
      session.lastMessageAt = Date.now();
    }

    // 持久化到数据库
    if (this.sessionRepo) {
      this.persistSession(guildId, channelId);
    }
  }

  setSessionClaudeId(guildId: string, channelId: string, claudeSessionId: string): void {
    const session = this.getSession(guildId, channelId);
    if (!session) return;
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;
    this.persistSession(guildId, channelId);

    // 同步更新 claude_sessions 表
    if (this.claudeSessionRepo) {
      this.claudeSessionRepo.getActiveByChannel(channelId).then((activeSession) => {
        if (activeSession) {
          activeSession.claudeSessionId = claudeSessionId;
          this.claudeSessionRepo!.save(activeSession);
        }
      });
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

    // 减少消息计数（回退一轮：user + assistant = 2条）
    session.messageCount = Math.max(0, session.messageCount - 2);

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

    // 归档旧表
    if (this.sessionRepo) {
      this.sessionRepo.archive(guildId, channelId, userId, reason);
    }

    // 归档新表
    if (this.channelRepo) {
      this.channelRepo.archive(channelId, userId, reason);
    }

    // 关闭活跃的 ClaudeSession
    if (this.claudeSessionRepo) {
      this.claudeSessionRepo.getActiveByChannel(channelId).then((activeSession) => {
        if (activeSession) {
          this.claudeSessionRepo!.close(activeSession.id);
        }
      });
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
    }

    return existed;
  }

  private clearChildParentRefs(guildId: string, parentChannelId: string): void {
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.parentChannelId === parentChannelId) {
        session.parentChannelId = undefined;
      }
    }
    // DB 层面也清除
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

  // ========== 按模型分槽的 Session 管理（Goal Fix 流程优化） ==========

  /**
   * 设置指定模型槽的 session ID
   * @param model - 'sonnet' 或 'opus'
   */
  setModelSessionId(
    guildId: string,
    threadId: string,
    model: 'sonnet' | 'opus',
    sessionId: string
  ): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;

    if (!session.sessionIds) session.sessionIds = {};
    if (!session.prevSessionIds) session.prevSessionIds = {};

    // 保存旧值（用于 rewind）
    if (session.sessionIds[model]) {
      session.prevSessionIds[model] = session.sessionIds[model];
    }

    session.sessionIds[model] = sessionId;
    session.claudeSessionId = sessionId;  // 标记当前活跃
    this.persistSession(guildId, threadId);
  }

  /**
   * 获取指定模型槽的 session ID
   */
  getModelSessionId(
    guildId: string,
    threadId: string,
    model: 'sonnet' | 'opus'
  ): string | undefined {
    const session = this.getSession(guildId, threadId);
    return session?.sessionIds?.[model];
  }

  /**
   * 清除指定模型槽
   */
  clearModelSessionId(
    guildId: string,
    threadId: string,
    model: 'sonnet' | 'opus'
  ): void {
    const session = this.getSession(guildId, threadId);
    if (!session || !session.sessionIds) return;
    session.sessionIds[model] = undefined;
    this.persistSession(guildId, threadId);
  }

  // ========== Session 状态追踪（hooks 事件处理）==========

  /**
   * 设置等待消息 ID
   */
  setWaitingMessageId(channelId: string, msgId: string): void {
    const tracking = this.sessionTracking.get(channelId) || {};
    tracking.waitingMessageId = msgId;
    this.sessionTracking.set(channelId, tracking);
  }

  /**
   * 获取等待消息 ID
   */
  getWaitingMessageId(channelId: string): string | undefined {
    return this.sessionTracking.get(channelId)?.waitingMessageId;
  }

  /**
   * 设置等待消息定时器
   */
  setWaitingTimer(channelId: string, timer: NodeJS.Timeout): void {
    const tracking = this.sessionTracking.get(channelId) || {};
    // 清除旧的定时器（明确检查 !== undefined）
    if (tracking.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
    }
    tracking.waitingTimer = timer;
    this.sessionTracking.set(channelId, tracking);
  }

  /**
   * 取消等待消息（清除定时器和消息ID）
   */
  cancelWaitingMessage(channelId: string): void {
    const tracking = this.sessionTracking.get(channelId);
    if (!tracking) return;

    // 明确检查 !== undefined 防止泄漏
    if (tracking.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
      tracking.waitingTimer = undefined;
    }
    tracking.waitingMessageId = undefined;
    this.sessionTracking.set(channelId, tracking);
  }

  /**
   * 清除 channel 的所有追踪状态
   */
  clearSessionTracking(channelId: string): void {
    const tracking = this.sessionTracking.get(channelId);
    if (tracking?.waitingTimer !== undefined) {
      clearTimeout(tracking.waitingTimer);
    }
    this.sessionTracking.delete(channelId);
  }
}
