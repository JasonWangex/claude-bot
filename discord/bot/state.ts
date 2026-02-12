/**
 * 状态管理（Guild + Forum Threads 模式）
 * 每个 Thread 对应一个独立 Session，不同 thread 并行无干扰
 * ID 全部使用 string (Discord snowflake)
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { Session, GuildState, ArchivedSession } from '../types/index.js';
import { logger } from '../utils/logger.js';

const MAX_HISTORY = 50;

interface PersistedData {
  sessions: Record<string, Session>;
  guilds: Record<string, GuildState>;
  archivedSessions?: Record<string, ArchivedSession>;
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();   // "guildId:threadId" → Session
  private guilds: Map<string, GuildState> = new Map();   // guildId → GuildState
  private archivedSessions: Map<string, ArchivedSession> = new Map();
  private defaultWorkDir: string;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private savePromise: Promise<void> = Promise.resolve();

  /**
   * 生成 thread 级别的固定 lockKey，用于 Claude 进程互斥
   */
  static threadLockKey(guildId: string, threadId: string): string {
    return `${guildId}:${threadId}`;
  }

  constructor(defaultWorkDir: string) {
    this.defaultWorkDir = defaultWorkDir;
    this.filePath = join(dirname(new URL(import.meta.url).pathname), '../../data/discord-states.json');
  }

  private threadKey(guildId: string, threadId: string): string {
    return `${guildId}:${threadId}`;
  }

  // ========== 加载 / 保存 ==========

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseError: any) {
        logger.error('Failed to parse state JSON, starting fresh:', parseError.message);
        return;
      }

      if (data.sessions && typeof data.sessions === 'object' && !Array.isArray(data.sessions)) {
        for (const [key, s] of Object.entries(data.sessions)) {
          this.sessions.set(key, s as Session);
        }
        if (data.guilds) {
          for (const [key, g] of Object.entries(data.guilds)) {
            this.guilds.set(key, g as GuildState);
          }
        }
        if (data.archivedSessions) {
          for (const [key, a] of Object.entries(data.archivedSessions)) {
            this.archivedSessions.set(key, a as ArchivedSession);
          }
        }
        logger.info(`Loaded ${this.sessions.size} session(s), ${this.guilds.size} guild(s), ${this.archivedSessions.size} archived from disk`);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info('No persisted state file, starting fresh');
        await this.saveToDisk();
      } else {
        logger.error('Failed to load state file:', err.message);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk().catch((err) => logger.error('Failed to save state:', err.message));
    }, 500);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  private async saveToDisk(): Promise<void> {
    this.savePromise = this.savePromise.then(async () => {
      const data: PersistedData = { sessions: {}, guilds: {}, archivedSessions: {} };
      for (const [key, session] of this.sessions.entries()) {
        data.sessions[key] = session;
      }
      for (const [guildId, guild] of this.guilds.entries()) {
        data.guilds[guildId] = guild;
      }
      for (const [key, archived] of this.archivedSessions.entries()) {
        data.archivedSessions![key] = archived;
      }
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await rename(tmpPath, this.filePath);
    }).catch((err) => logger.error('saveToDisk error:', err.message));
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
      this.scheduleSave();
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
    }

    this.scheduleSave();
  }

  setSessionClaudeId(guildId: string, threadId: string, claudeSessionId: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;
    this.scheduleSave();
  }

  setSessionCwd(guildId: string, threadId: string, cwd: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.cwd = cwd;
    this.scheduleSave();
  }

  clearSessionClaudeId(guildId: string, threadId: string): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.claudeSessionId = undefined;
    session.prevClaudeSessionId = undefined;
    this.scheduleSave();
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

    this.scheduleSave();
    return { success: true, prevId };
  }

  setSessionModel(guildId: string, threadId: string, model: string | undefined): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.model = model;
    this.scheduleSave();
  }

  setSessionPlanMode(guildId: string, threadId: string, planMode: boolean): void {
    const session = this.getSession(guildId, threadId);
    if (!session) return;
    session.planMode = planMode;
    this.scheduleSave();
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
    this.scheduleSave();
  }

  setGuildDefaultCwd(guildId: string, cwd: string): void {
    const guild = this.guilds.get(guildId);
    if (guild) {
      guild.defaultCwd = cwd;
      guild.lastActivity = Date.now();
    } else {
      this.guilds.set(guildId, { guildId, defaultCwd: cwd, lastActivity: Date.now() });
    }
    this.scheduleSave();
  }

  // ========== 清理 ==========

  cleanup(): void {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 天
    let cleaned = false;

    for (const [key, session] of this.sessions.entries()) {
      const lastActive = session.lastMessageAt || session.createdAt;
      if (now - lastActive > maxAge) {
        this.sessions.delete(key);
        cleaned = true;
      }
    }

    if (cleaned) this.scheduleSave();
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
    this.scheduleSave();
    return true;
  }

  deleteSession(guildId: string, threadId: string): boolean {
    const key = this.threadKey(guildId, threadId);
    const existed = this.sessions.has(key);

    if (existed) {
      this.sessions.delete(key);
      this.clearChildParentRefs(guildId, threadId);
      this.scheduleSave();
    }

    return existed;
  }

  private clearChildParentRefs(guildId: string, parentThreadId: string): void {
    for (const session of this.sessions.values()) {
      if (session.guildId === guildId && session.parentThreadId === parentThreadId) {
        session.parentThreadId = undefined;
      }
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

    this.scheduleSave();
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
    this.scheduleSave();
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
    this.scheduleSave();
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
    this.scheduleSave();
  }
}
