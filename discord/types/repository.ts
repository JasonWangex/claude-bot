/**
 * Repository 接口定义
 *
 * 统一的数据访问抽象层，SQLite 存储后端的接口契约。
 * 所有 Repository 方法返回 Promise 以支持异步存储后端。
 */

import type {
  Session,
  ArchivedSession,
  GuildState,
  GoalDriveState,
  GoalDriveStatus,
  GoalTask,
  GoalTaskStatus,
} from './index.js';

// ==================== 新增实体类型 ====================
// DevLog 和 Idea 实体定义

/** 开发日志 */
export interface DevLog {
  id: string;
  name: string;
  date: string;              // ISO-8601 日期 (yyyy-MM-dd)
  project: string;
  branch: string;
  summary: string;
  commits: number;
  linesChanged: string;      // diff stat 原文，如 "5 files changed, 180 insertions(+), 42 deletions(-)"
  goal?: string;             // 关联的 Goal 名称
  content?: string;          // Markdown 格式的详细内容
  createdAt: number;
}

/** Idea 状态 */
export type IdeaStatus = 'Idea' | 'Processing' | 'Active' | 'Paused' | 'Done' | 'Dropped';

/** 想法记录 */
export interface Idea {
  id: string;
  name: string;
  status: IdeaStatus;
  project: string;
  date: string;              // ISO-8601 日期 (yyyy-MM-dd)
  createdAt: number;
  updatedAt: number;
}

// ==================== Repository 接口 ====================

/**
 * Session 仓库
 *
 * 管理 Discord Thread 对应的会话，包括活跃会话和归档会话。
 * 复合键: (guildId, threadId)
 */
export interface ISessionRepo {
  // —— CRUD ——
  get(guildId: string, threadId: string): Promise<Session | null>;
  getAll(guildId: string): Promise<Session[]>;
  save(session: Session): Promise<void>;
  delete(guildId: string, threadId: string): Promise<boolean>;

  // —— 查询 ——
  findByClaudeSessionId(guildId: string, claudeSessionId: string): Promise<Session | null>;
  findByParentThreadId(guildId: string, parentThreadId: string): Promise<Session[]>;

  // —— 归档 ——
  archive(guildId: string, threadId: string, userId?: string, reason?: string): Promise<boolean>;
  restore(guildId: string, threadId: string): Promise<boolean>;
  getArchived(guildId: string, threadId: string): Promise<ArchivedSession | null>;
  getAllArchived(guildId: string): Promise<ArchivedSession[]>;

  // —— 统计 ——
  count(): Promise<number>;
}

/**
 * Guild 仓库
 *
 * 管理 Discord Guild 的全局配置。
 * 主键: guildId
 */
export interface IGuildRepo {
  get(guildId: string): Promise<GuildState | null>;
  save(guild: GuildState): Promise<void>;
  delete(guildId: string): Promise<boolean>;
}

/**
 * Goal 仓库
 *
 * 管理 Goal Drive 的状态（不含 tasks，tasks 由 IGoalTaskRepo 管理）。
 * 主键: goalId
 */
export interface IGoalRepo {
  get(goalId: string): Promise<GoalDriveState | null>;
  getAll(): Promise<GoalDriveState[]>;
  save(state: GoalDriveState): Promise<void>;
  delete(goalId: string): Promise<boolean>;

  // —— 查询 ——
  findByStatus(status: GoalDriveStatus): Promise<GoalDriveState[]>;
}

/**
 * GoalTask 仓库
 *
 * 管理 Goal 下的子任务。
 * 复合键: (goalId, taskId)
 */
export interface IGoalTaskRepo {
  get(goalId: string, taskId: string): Promise<GoalTask | null>;
  getAllByGoal(goalId: string): Promise<GoalTask[]>;
  save(goalId: string, task: GoalTask): Promise<void>;
  saveAll(goalId: string, tasks: GoalTask[]): Promise<void>;
  delete(goalId: string, taskId: string): Promise<boolean>;
  deleteAllByGoal(goalId: string): Promise<void>;

  // —— 查询 ——
  findByStatus(goalId: string, status: GoalTaskStatus): Promise<GoalTask[]>;
  findByThreadId(threadId: string): Promise<{ goalId: string; task: GoalTask } | null>;
}

/**
 * DevLog 仓库
 *
 * 管理开发日志记录。
 * 主键: id
 */
export interface IDevLogRepo {
  get(id: string): Promise<DevLog | null>;
  getAll(): Promise<DevLog[]>;
  save(log: DevLog): Promise<void>;
  delete(id: string): Promise<boolean>;

  // —— 查询 ——
  findByProject(project: string): Promise<DevLog[]>;
  findByDateRange(start: string, end: string): Promise<DevLog[]>;
  findByGoal(goal: string): Promise<DevLog[]>;
}

/**
 * Idea 仓库
 *
 * 管理想法记录。
 * 主键: id
 */
export interface IIdeaRepo {
  get(id: string): Promise<Idea | null>;
  getAll(): Promise<Idea[]>;
  save(idea: Idea): Promise<void>;
  delete(id: string): Promise<boolean>;

  // —— 查询 ——
  findByStatus(status: IdeaStatus): Promise<Idea[]>;
  findByProject(project: string): Promise<Idea[]>;
  findByProjectAndStatus(project: string, status: IdeaStatus): Promise<Idea[]>;
}
