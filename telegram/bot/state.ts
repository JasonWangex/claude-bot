/**
 * 状态管理（Group + Forum Topics 模式）
 * 每个 Topic 对应一个独立 Session，不同 topic 并行无干扰
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { Session, GroupState, ArchivedSession } from '../types/index.js';
import { logger } from '../utils/logger.js';

const MAX_HISTORY = 50;

interface PersistedData {
  sessions: Record<string, Session>;
  groups: Record<string, GroupState>;
  archivedSessions?: Record<string, ArchivedSession>;
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();   // "groupId:topicId" → Session
  private groups: Map<number, GroupState> = new Map();   // groupId → GroupState
  private archivedSessions: Map<string, ArchivedSession> = new Map();   // "groupId:topicId" → ArchivedSession
  private defaultWorkDir: string;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private savePromise: Promise<void> = Promise.resolve();

  /**
   * 生成 topic 级别的固定 lockKey，用于 Claude 进程互斥
   * 固定格式避免因 claudeSessionId 变化导致锁失效
   */
  static topicLockKey(groupId: number, topicId: number): string {
    return `${groupId}:${topicId}`;
  }

  constructor(defaultWorkDir: string) {
    this.defaultWorkDir = defaultWorkDir;
    this.filePath = join(dirname(new URL(import.meta.url).pathname), '../../data/telegram-states.json');
  }

  private topicKey(groupId: number, topicId: number): string {
    return `${groupId}:${topicId}`;
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

      // 新格式: { sessions: {...}, groups: {...}, archivedSessions: {...} }
      if (data.sessions && typeof data.sessions === 'object' && !Array.isArray(data.sessions)) {
        for (const [key, s] of Object.entries(data.sessions)) {
          this.sessions.set(key, s as Session);
        }
        if (data.groups) {
          for (const [key, g] of Object.entries(data.groups)) {
            this.groups.set(Number(key), g as GroupState);
          }
        }
        if (data.archivedSessions) {
          for (const [key, a] of Object.entries(data.archivedSessions)) {
            this.archivedSessions.set(key, a as ArchivedSession);
          }
        }
        logger.info(`Loaded ${this.sessions.size} session(s), ${this.groups.size} group(s), ${this.archivedSessions.size} archived from disk`);
      } else {
        // 旧格式 (userId → UserState)，无法映射到 topic，丢弃
        logger.info('Detected legacy state format, starting fresh (old sessions discarded)');
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.info('No persisted state file, starting fresh');
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
      const data: PersistedData = { sessions: {}, groups: {}, archivedSessions: {} };
      for (const [key, session] of this.sessions.entries()) {
        data.sessions[key] = session;
      }
      for (const [groupId, group] of this.groups.entries()) {
        data.groups[String(groupId)] = group;
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

  getOrCreateSession(groupId: number, topicId: number, defaults: { name: string; cwd: string }): Session {
    const key = this.topicKey(groupId, topicId);
    if (!this.sessions.has(key)) {
      const groupModel = this.getGroupDefaultModel(groupId);
      const session: Session = {
        id: randomUUID(),
        name: defaults.name,
        topicId,
        groupId,
        cwd: defaults.cwd,
        createdAt: Date.now(),
        model: groupModel,
        messageHistory: [],
      };
      this.sessions.set(key, session);
      this.scheduleSave();
    }
    return this.sessions.get(key)!;
  }

  getSession(groupId: number, topicId: number): Session | undefined {
    return this.sessions.get(this.topicKey(groupId, topicId));
  }

  getAllSessions(groupId: number): Session[] {
    const result: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.groupId === groupId) result.push(session);
    }
    return result;
  }

  /**
   * 查找持有指定 claudeSessionId 的 session（同 group 内）
   * 用于 /attach 命令防止两个 topic 持有同一个 session
   */
  findSessionHolder(groupId: number, claudeSessionId: string): { topicId: number; name: string } | null {
    for (const session of this.sessions.values()) {
      if (session.groupId === groupId && session.claudeSessionId === claudeSessionId) {
        return { topicId: session.topicId, name: session.name };
      }
    }
    return null;
  }

  // ========== Session 操作 ==========

  updateSessionMessage(groupId: number, topicId: number, text: string, role: 'user' | 'assistant'): void {
    const session = this.getSession(groupId, topicId);
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

  setSessionClaudeId(groupId: number, topicId: number, claudeSessionId: string): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    if (session.claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.prevClaudeSessionId = session.claudeSessionId;
    }
    session.claudeSessionId = claudeSessionId;
    this.scheduleSave();
  }

  setSessionCwd(groupId: number, topicId: number, cwd: string): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.cwd = cwd;
    this.scheduleSave();
  }

  clearSessionClaudeId(groupId: number, topicId: number): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.claudeSessionId = undefined;
    session.prevClaudeSessionId = undefined;
    this.scheduleSave();
  }

  rewindSession(groupId: number, topicId: number): { success: boolean; reason?: string; prevId?: string } {
    const session = this.getSession(groupId, topicId);
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

  setSessionModel(groupId: number, topicId: number, model: string | undefined): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.model = model;
    this.scheduleSave();
  }

  setSessionPlanMode(groupId: number, topicId: number, planMode: boolean): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.planMode = planMode;
    this.scheduleSave();
  }

  // ========== Group ==========

  getGroupDefaultCwd(groupId: number): string {
    return this.groups.get(groupId)?.defaultCwd || this.defaultWorkDir;
  }

  getGroupDefaultModel(groupId: number): string | undefined {
    return this.groups.get(groupId)?.defaultModel;
  }

  setGroupDefaultModel(groupId: number, model: string | undefined): void {
    const group = this.groups.get(groupId);
    if (group) {
      group.defaultModel = model;
      group.lastActivity = Date.now();
    } else {
      this.groups.set(groupId, { groupId, defaultCwd: this.defaultWorkDir, defaultModel: model, lastActivity: Date.now() });
    }
    this.scheduleSave();
  }

  setGroupDefaultCwd(groupId: number, cwd: string): void {
    const group = this.groups.get(groupId);
    if (group) {
      group.defaultCwd = cwd;
      group.lastActivity = Date.now();
    } else {
      this.groups.set(groupId, { groupId, defaultCwd: cwd, lastActivity: Date.now() });
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

  // ========== Topic 归档管理 ==========

  /**
   * 归档一个 Session
   * @param groupId 群组 ID
   * @param topicId Topic ID
   * @param userId 执行归档的用户 ID（可选）
   * @param reason 归档原因（可选）
   * @returns 是否成功归档
   */
  archiveSession(groupId: number, topicId: number, userId?: number, reason?: string): boolean {
    const key = this.topicKey(groupId, topicId);
    const session = this.sessions.get(key);

    if (!session) {
      return false;
    }

    // 创建归档会话
    const archivedSession: ArchivedSession = {
      ...session,
      archivedAt: Date.now(),
      archivedBy: userId,
      archiveReason: reason,
    };

    // 移动到归档
    this.archivedSessions.set(key, archivedSession);
    this.sessions.delete(key);

    this.scheduleSave();
    return true;
  }

  /**
   * 删除一个 Session（不归档，直接删除）
   * @param groupId 群组 ID
   * @param topicId Topic ID
   * @returns 是否成功删除
   */
  deleteSession(groupId: number, topicId: number): boolean {
    const key = this.topicKey(groupId, topicId);
    const existed = this.sessions.has(key);

    if (existed) {
      this.sessions.delete(key);
      this.scheduleSave();
    }

    return existed;
  }

  /**
   * 获取归档的 Session
   * @param groupId 群组 ID
   * @param topicId Topic ID
   * @returns 归档的 Session 或 undefined
   */
  getArchivedSession(groupId: number, topicId: number): ArchivedSession | undefined {
    return this.archivedSessions.get(this.topicKey(groupId, topicId));
  }

  /**
   * 恢复归档的 Session
   * @param groupId 群组 ID
   * @param topicId Topic ID
   * @returns 是否成功恢复
   */
  restoreArchivedSession(groupId: number, topicId: number): boolean {
    const key = this.topicKey(groupId, topicId);
    const archived = this.archivedSessions.get(key);

    if (!archived) {
      return false;
    }

    // 移除归档特有字段，恢复为普通 Session
    const { archivedAt, archivedBy, archiveReason, ...session } = archived;

    this.sessions.set(key, session as Session);
    this.archivedSessions.delete(key);

    this.scheduleSave();
    return true;
  }

  /**
   * 获取群组所有归档的 Session
   * @param groupId 群组 ID
   * @returns 归档的 Session 列表
   */
  getAllArchivedSessions(groupId: number): ArchivedSession[] {
    const result: ArchivedSession[] = [];
    for (const archived of this.archivedSessions.values()) {
      if (archived.groupId === groupId) {
        result.push(archived);
      }
    }
    return result;
  }

  /**
   * 获取所有 Session 当前占用的工作目录路径集合
   * @param groupId 群组 ID
   * @returns 工作目录路径集合
   */
  getOccupiedWorkDirs(groupId: number): Set<string> {
    const paths = new Set<string>();

    for (const session of this.sessions.values()) {
      if (session.groupId === groupId) {
        paths.add(session.cwd);
      }
    }

    return paths;
  }

  /**
   * 设置 Session 的 Fork 信息（parentTopicId + worktreeBranch）
   */
  setSessionForkInfo(groupId: number, topicId: number, parentTopicId: number, worktreeBranch: string): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.parentTopicId = parentTopicId;
    session.worktreeBranch = worktreeBranch;
    this.scheduleSave();
  }

  /**
   * 设置 Session 的 icon 信息
   */
  setSessionIcon(groupId: number, topicId: number, iconColor?: number, iconCustomEmojiId?: string): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.iconColor = iconColor;
    session.iconCustomEmojiId = iconCustomEmojiId;
    this.scheduleSave();
  }

  /**
   * 沿 parentTopicId 链向上查找 root Session
   */
  getRootSession(groupId: number, topicId: number): Session | undefined {
    let session = this.getSession(groupId, topicId);
    if (!session) return undefined;
    while (session.parentTopicId != null) {
      const parent = this.getSession(groupId, session.parentTopicId);
      if (!parent) break;
      session = parent;
    }
    return session;
  }

  /**
   * 清除 Session 的 parentTopicId（提升为顶层 Topic）
   */
  clearSessionParent(groupId: number, topicId: number): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.parentTopicId = undefined;
    this.scheduleSave();
  }

  /**
   * 获取某 Topic 的子 Session（通过 parentTopicId 关联）
   */
  getChildSessions(groupId: number, parentTopicId: number): Session[] {
    const result: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.groupId === groupId && session.parentTopicId === parentTopicId) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * 更新 Session 名称
   * @param groupId 群组 ID
   * @param topicId Topic ID
   * @param name 新名称
   */
  setSessionName(groupId: number, topicId: number, name: string): void {
    const session = this.getSession(groupId, topicId);
    if (!session) return;
    session.name = name;
    this.scheduleSave();
  }
}
