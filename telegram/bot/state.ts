/**
 * 用户状态管理（带 JSON 文件持久化 + 多会话支持）
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { UserState, Session } from '../types/index.js';
import { logger } from '../utils/logger.js';

const MAX_HISTORY = 50;

// 旧格式（用于自动迁移）
interface LegacyPersistedState {
  sessionId?: string;
  cwd: string;
  authorized: boolean;
  lastActivity: number;
}

type PersistedData = Record<string, UserState | LegacyPersistedState>;

export class StateManager {
  private states: Map<number, UserState>;
  private defaultWorkDir: string;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(defaultWorkDir: string) {
    this.states = new Map();
    this.defaultWorkDir = defaultWorkDir;
    this.filePath = join(dirname(new URL(import.meta.url).pathname), '../../data/telegram-states.json');
  }

  /**
   * 启动时从文件加载状态，自动迁移旧格式
   */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data: PersistedData = JSON.parse(raw);
      let migrated = false;

      for (const [key, s] of Object.entries(data)) {
        if (this.isLegacyState(s)) {
          // 自动迁移旧格式
          const session = this.createDefaultSession(s.cwd || this.defaultWorkDir);
          if (s.sessionId) {
            session.claudeSessionId = s.sessionId;
          }
          this.states.set(Number(key), {
            sessions: [session],
            activeSessionId: session.id,
            lastActivity: s.lastActivity || Date.now(),
            authorized: s.authorized || false,
          });
          migrated = true;
        } else {
          // 新格式直接加载
          this.states.set(Number(key), s as UserState);
        }
      }

      logger.info(`Loaded ${this.states.size} user state(s) from disk`);
      if (migrated) {
        logger.info('Migrated legacy state format to multi-session format');
        this.scheduleSave();
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info('No persisted state file, starting fresh');
      } else {
        logger.error('Failed to load state file:', err.message);
      }
    }
  }

  private isLegacyState(s: any): s is LegacyPersistedState {
    return !Array.isArray(s.sessions);
  }

  private createDefaultSession(cwd: string): Session {
    return {
      id: randomUUID(),
      name: 'default',
      cwd,
      createdAt: Date.now(),
      messageHistory: [],
    };
  }

  /**
   * 延迟写入，合并短时间内的多次变更
   */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk().catch((err) => logger.error('Failed to save state:', err.message));
    }, 500);
  }

  /**
   * 立即刷新挂起的保存（用于进程退出前）
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  private savePromise: Promise<void> = Promise.resolve();

  private async saveToDisk(): Promise<void> {
    // 串行化写入，防止并发竞态
    this.savePromise = this.savePromise.then(async () => {
      const data: Record<string, UserState> = {};
      for (const [userId, state] of this.states.entries()) {
        data[String(userId)] = state;
      }
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await rename(tmpPath, this.filePath);
    }).catch((err) => logger.error('saveToDisk error:', err.message));
  }

  get(userId: number): UserState {
    if (!this.states.has(userId)) {
      const session = this.createDefaultSession(this.defaultWorkDir);
      this.states.set(userId, {
        sessions: [session],
        activeSessionId: session.id,
        lastActivity: Date.now(),
        authorized: false,
      });
    }

    const state = this.states.get(userId)!;
    state.lastActivity = Date.now();
    return state;
  }

  // ========== 会话管理 ==========

  getActiveSession(userId: number): Session {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (!session) {
      // 安全回退：如果找不到 active session，用第一个
      const first = state.sessions[0];
      state.activeSessionId = first.id;
      return first;
    }
    return session;
  }

  getSessions(userId: number): Session[] {
    return this.get(userId).sessions;
  }

  getSessionByName(userId: number, name: string): Session | undefined {
    const state = this.get(userId);
    return state.sessions.find(s => s.name === name);
  }

  getSessionById(userId: number, sessionId: string): Session | undefined {
    const state = this.get(userId);
    return state.sessions.find(s => s.id === sessionId);
  }

  createSession(userId: number, name: string, cwd?: string): Session {
    const state = this.get(userId);
    const activeSession = this.getActiveSession(userId);
    const session: Session = {
      id: randomUUID(),
      name,
      cwd: cwd || activeSession.cwd,
      createdAt: Date.now(),
      messageHistory: [],
    };
    state.sessions.push(session);
    this.scheduleSave();
    return session;
  }

  switchSession(userId: number, sessionId: string): boolean {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return false;
    state.activeSessionId = sessionId;
    this.scheduleSave();
    return true;
  }

  renameSession(userId: number, sessionId: string, newName: string): boolean {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return false;
    session.name = newName;
    this.scheduleSave();
    return true;
  }

  deleteSession(userId: number, sessionId: string): { success: boolean; reason?: string } {
    const state = this.get(userId);
    if (state.sessions.length <= 1) {
      return { success: false, reason: '不能删除唯一的会话' };
    }
    const idx = state.sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) {
      return { success: false, reason: '会话不存在' };
    }
    state.sessions.splice(idx, 1);
    // 如果删除的是当前活跃会话，切换到第一个
    if (state.activeSessionId === sessionId) {
      state.activeSessionId = state.sessions[0].id;
    }
    this.scheduleSave();
    return { success: true };
  }

  updateSessionMessage(userId: number, sessionId: string, text: string, role: 'user' | 'assistant'): void {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
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

  setSessionClaudeId(userId: number, sessionId: string, claudeSessionId: string): void {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;
    // 保存上一轮 session ID 用于 rewind
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;
    this.scheduleSave();
  }

  setSessionCwd(userId: number, sessionId: string, cwd: string): void {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;
    session.cwd = cwd;
    this.scheduleSave();
  }

  clearSessionClaudeId(userId: number, sessionId: string): void {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;
    session.claudeSessionId = undefined;
    session.prevClaudeSessionId = undefined;
    this.scheduleSave();
  }

  rewindSession(userId: number, sessionId: string): { success: boolean; reason?: string; prevId?: string } {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return { success: false, reason: '会话不存在' };
    if (!session.prevClaudeSessionId) return { success: false, reason: '没有可撤销的对话轮次' };

    const prevId = session.prevClaudeSessionId;
    session.claudeSessionId = prevId;
    session.prevClaudeSessionId = undefined;

    // 移除最后一轮 user+assistant 消息
    const history = session.messageHistory;
    // 从后往前找到最后一条 assistant，删除它和它之前连续的 user
    let i = history.length - 1;
    while (i >= 0 && history[i].role === 'assistant') i--;
    // i 现在指向最后一条 user（或 -1）
    const removeFrom = i >= 0 && history[i].role === 'user' ? i : i + 1;
    if (removeFrom < history.length) {
      history.splice(removeFrom);
    }

    this.scheduleSave();
    return { success: true, prevId };
  }

  setSessionPlanMode(userId: number, sessionId: string, planMode: boolean): void {
    const state = this.get(userId);
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;
    session.planMode = planMode;
    this.scheduleSave();
  }

  // ========== 代理方法（兼容旧调用） ==========

  setAuthorized(userId: number, authorized: boolean): void {
    const state = this.get(userId);
    state.authorized = authorized;
    this.scheduleSave();
  }

  isAuthorized(userId: number): boolean {
    const state = this.get(userId);
    return state.authorized;
  }

  setCwd(userId: number, cwd: string): void {
    const session = this.getActiveSession(userId);
    this.setSessionCwd(userId, session.id, cwd);
  }

  setSessionId(userId: number, sessionId: string): void {
    const session = this.getActiveSession(userId);
    this.setSessionClaudeId(userId, session.id, sessionId);
  }

  clearSession(userId: number): void {
    const session = this.getActiveSession(userId);
    this.clearSessionClaudeId(userId, session.id);
  }

  cleanup(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    let cleaned = false;

    for (const [userId, state] of this.states.entries()) {
      if (now - state.lastActivity > maxAge) {
        this.states.delete(userId);
        cleaned = true;
      }
    }

    if (cleaned) this.scheduleSave();
  }

  getActiveCount(): number {
    return this.states.size;
  }
}
