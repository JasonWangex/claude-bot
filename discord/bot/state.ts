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
import { Session, GuildState, ArchivedSession } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { SessionRepository } from '../db/repo/session-repo.js';
import type { GuildRepository } from '../db/repo/guild-repo.js';

const MAX_HISTORY = 50;

export class StateManager {
  private sessions: Map<string, Session> = new Map();   // "guildId:threadId" → Session
  private guilds: Map<string, GuildState> = new Map();   // guildId → GuildState
  private archivedSessions: Map<string, ArchivedSession> = new Map();
  private defaultWorkDir: string;

  /**
   * 生成 thread 级别的固定 lockKey，用于 Claude 进程互斥
   */
  static threadLockKey(guildId: string, threadId: string): string {
    return `${guildId}:${threadId}`;
  }

  constructor(
    defaultWorkDir: string,
    private sessionRepo?: SessionRepository,
    private guildRepo?: GuildRepository,
  ) {
    this.defaultWorkDir = defaultWorkDir;
  }

  private threadKey(guildId: string, threadId: string): string {
    return `${guildId}:${threadId}`;
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
          this.sessions.set(this.threadKey(s.guildId, s.threadId), s);
        }
        for (const g of migratedGuilds) {
          this.guilds.set(g.guildId, g);
        }
      } else {
        for (const s of sessions) {
          this.sessions.set(this.threadKey(s.guildId, s.threadId), s);
        }
        for (const g of guilds) {
          this.guilds.set(g.guildId, g);
        }
      }

      const archived = this.sessionRepo.loadAllArchived();
      for (const a of archived) {
        this.archivedSessions.set(this.threadKey(a.guildId, a.threadId), a);
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
          archived.threadId,
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

  private persistSession(guildId: string, threadId: string): void {
    if (!this.sessionRepo) return;
    const session = this.sessions.get(this.threadKey(guildId, threadId));
    if (session) {
      this.sessionRepo.save(session);
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

  getOrCreateSession(guildId: string, threadId: string, defaults: { name: string; cwd: string }): Session {
    const key = this.threadKey(guildId, threadId);
    if (!this.sessions.has(key)) {
      const guildModel = this.getGuildDefaultModel(guildId);
      const session: Session = {
        id: randomUUID(),
        name: defaults.name,
        threadId,
        guildId,
        cwd: defaults.cwd,
        createdAt: Date.now(),
        model: guildModel,
        messageHistory: [],
      };
      this.sessions.set(key, session);
      this.persistSession(guildId, threadId);
    }
    return this.sessions.get(key)!;
  }

  getSession(guildId: string, threadId: string): Session | undefined {
    return this.sessions.get(this.threadKey(guildId, threadId));
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
  findSessionHolder(guildId: string, claudeSessionId: string): { threadId: string; name: string } | null {
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.claudeSessionId === claudeSessionId) {
        return { threadId: session.threadId, name: session.name };
      }
    }
    return null;
  }

  // ========== Session 操作 ==========

  updateSessionMessage(guildId: string, threadId: string, text: string, role: 'user' | 'assistant'): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;

    const entry = { role, text: text.slice(0, 2000), timestamp: Date.now() };
    session.messageHistory.push(entry);
    if (session.messageHistory.length > MAX_HISTORY) {
      session.messageHistory = session.messageHistory.slice(-MAX_HISTORY);
    }

    if (role === 'assistant') {
      session.lastMessage = text.slice(0, 500);
      session.lastMessageAt = Date.now();
      // 更新 sessions 表的 last_message 字段
      if (this.sessionRepo) {
        this.persistSession(guildId, threadId);
      }
    }
  }

  setSessionClaudeId(guildId: string, threadId: string, claudeSessionId: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;
    this.persistSession(guildId, threadId);
  }

  setSessionCwd(guildId: string, threadId: string, cwd: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.cwd = cwd;
    this.persistSession(guildId, threadId);
  }

  clearSessionClaudeId(guildId: string, threadId: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.claudeSessionId = undefined;
    session.prevClaudeSessionId = undefined;
    this.persistSession(guildId, threadId);
  }

  rewindSession(guildId: string, threadId: string): { success: boolean; reason?: string; prevId?: string } {
    const session = this.getSession(guildId, threadId);
    if (!session) return { success: false, reason: '会话不存在' };
    if (!session.prevClaudeSessionId) return { success: false, reason: '没有可撤销的对话轮次' };

    const prevId = session.prevClaudeSessionId;
    session.claudeSessionId = prevId;
    session.prevClaudeSessionId = undefined;

    const history = session.messageHistory;
    let i = history.length - 1;
    while (i >= 0 && history[i].role === 'assistant') i--;
    const removeFrom = i >= 0 && history[i].role === 'user' ? i : i + 1;
    if (removeFrom < history.length) {
      history.splice(removeFrom);
    }

    this.persistSession(guildId, threadId);
    return { success: true, prevId };
  }

  setSessionModel(guildId: string, threadId: string, model: string | undefined): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.model = model;
    this.persistSession(guildId, threadId);
  }

  setSessionPlanMode(guildId: string, threadId: string, planMode: boolean): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.planMode = planMode;
    this.persistSession(guildId, threadId);
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
          this.sessionRepo.delete(session.guildId, session.threadId);
        }
      }
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // ========== Thread 归档管理 ==========

  archiveSession(guildId: string, threadId: string, userId?: string, reason?: string): boolean {
    const key = this.threadKey(guildId, threadId);
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
    this.clearChildParentRefs(guildId, threadId);

    logger.info(`Archived session: ${session.name} (thread=${threadId}, guild=${guildId})`);

    if (this.sessionRepo) {
      this.sessionRepo.archive(guildId, threadId, userId, reason);
    }
    return true;
  }

  deleteSession(guildId: string, threadId: string): boolean {
    const key = this.threadKey(guildId, threadId);
    const existed = this.sessions.has(key);

    if (existed) {
      this.sessions.delete(key);
      this.clearChildParentRefs(guildId, threadId);
      if (this.sessionRepo) {
        this.sessionRepo.delete(guildId, threadId);
      }
    }

    return existed;
  }

  private clearChildParentRefs(guildId: string, parentThreadId: string): void {
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.parentThreadId === parentThreadId) {
        session.parentThreadId = undefined;
      }
    }
    // DB 层面也清除
    if (this.sessionRepo) {
      this.sessionRepo.clearParentRefs(guildId, parentThreadId);
    }
  }

  getArchivedSession(guildId: string, threadId: string): ArchivedSession | undefined {
    return this.archivedSessions.get(this.threadKey(guildId, threadId));
  }

  restoreArchivedSession(guildId: string, threadId: string): boolean {
    const key = this.threadKey(guildId, threadId);
    const archived = this.archivedSessions.get(key);

    if (!archived) return false;

    const { archivedAt, archivedBy, archiveReason, ...session } = archived;

    this.sessions.set(key, session as Session);
    this.archivedSessions.delete(key);

    if (this.sessionRepo) {
      this.sessionRepo.restore(guildId, threadId);
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

  setSessionForkInfo(guildId: string, threadId: string, parentThreadId: string, worktreeBranch: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.parentThreadId = parentThreadId;
    session.worktreeBranch = worktreeBranch;
    this.persistSession(guildId, threadId);
  }

  getRootSession(guildId: string, threadId: string): Session | undefined {
    let session = this.getSession(guildId, threadId);
    if (!session) return undefined;
    while (session.parentThreadId != null) {
      const parent = this.getSession(guildId, session.parentThreadId);
      if (!parent) break;
      session = parent;
    }
    return session;
  }

  clearSessionParent(guildId: string, threadId: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.parentThreadId = undefined;
    this.persistSession(guildId, threadId);
  }

  getChildSessions(guildId: string, parentThreadId: string): Session[] {
    const result: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.parentThreadId === parentThreadId) {
        result.push(session);
      }
    }
    return result;
  }

  setSessionName(guildId: string, threadId: string, name: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.name = name;
    this.persistSession(guildId, threadId);
  }
}
