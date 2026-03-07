/**
 * Repository 接口定义
 *
 * 统一的数据访问抽象层，SQLite 存储后端的接口契约。
 * 所有 Repository 方法返回 Promise 以支持异步存储后端。
 */

import type {
  GuildState,
  GoalDriveState,
  Task,
  TaskStatus,
  GoalTask,
  GoalTaskStatus,
  Channel,
  ClaudeSession,
  ChatUsageResult,
} from './index.js';

// ==================== 新增实体类型 ====================
// Goal、DevLog 和 Idea 实体定义

// 从 db.ts 统一导出，避免重复定义
import type { GoalStatus, GoalType } from './db.js';
export type { GoalStatus, GoalType } from './db.js';

/** 开发目标（元数据视图，对应 goals 表的完整行） */
export interface Goal {
  id: string;
  name: string;
  status: GoalStatus;
  type: GoalType | null;
  project: string | null;
  date: string | null;           // ISO-8601 日期 (yyyy-MM-dd)
  completion: string | null;     // 完成标准
  body: string | null;           // 页面正文 Markdown
  seq: number | null;            // 短序号，用于子任务命名前缀（g1, g2, ...）
}

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

/** Idea 类型 */
export type IdeaType = 'manual' | 'todo';

/** 想法记录 */
export interface Idea {
  id: string;
  name: string;
  status: IdeaStatus;
  type: IdeaType;            // 类型：手动输入或待处理事项
  project: string;
  date: string;              // ISO-8601 日期 (yyyy-MM-dd)
  body: string | null;       // Markdown 正文内容
  createdAt: number;
  updatedAt: number;
}

/** Goal 待办事项 */
export type GoalTodoPriority = '重要' | '高' | '中' | '低';

export interface GoalTodo {
  id: string;
  goalId: string;
  content: string;
  done: boolean;
  source: string | null;
  priority: GoalTodoPriority;
  createdAt: number;
  updatedAt: number;
}

// ==================== Repository 接口 ====================

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
 * Goal 仓库（已合并原 GoalMetaRepo）
 *
 * 管理 Goal 的完整元数据及 Drive 运行状态。
 * 主键: goalId
 */
export interface IGoalRepo {
  // —— Drive 状态（GoalDriveState）——
  get(goalId: string): Promise<GoalDriveState | null>;
  getAll(): Promise<GoalDriveState[]>;
  save(state: GoalDriveState): Promise<void>;
  delete(goalId: string): Promise<boolean>;

  // —— Drive 状态查询 ——
  findByStatuses(statuses: GoalStatus[]): Promise<GoalDriveState[]>;

  // —— Goal 元数据（Goal）——
  getMeta(goalId: string): Promise<Goal | null>;
  getAllMeta(): Promise<Goal[]>;
  saveMeta(goal: Goal): Promise<void>;
  findGoalsByStatus(status: GoalStatus): Promise<Goal[]>;
  findByProject(project: string): Promise<Goal[]>;
  search(query: string): Promise<Goal[]>;
}

/**
 * Task 仓库
 *
 * 管理独立 Task 和 Goal 子任务的统一仓库。
 * 主键: taskId (全局唯一)
 * goalId 为可选字段（null 表示独立任务，如 qdev）
 */
export interface ITaskRepo {
  // —— CRUD（taskId 为主键）——
  getById(taskId: string): Promise<Task | null>;
  save(task: Task, goalId?: string | null): Promise<void>;
  saveAll(tasks: Task[], goalId?: string | null): Promise<void>;
  delete(taskId: string): Promise<boolean>;

  // —— Goal 维度查询 ——
  getAllByGoal(goalId: string): Promise<Task[]>;
  deleteAllByGoal(goalId: string): Promise<void>;
  findByStatus(goalId: string, status: TaskStatus): Promise<Task[]>;

  // —— 全局查询 ——
  findByChannelId(channelId: string): Promise<{ goalId: string | null; task: Task } | null>;

  // —— 聚合 ——
  getGoalUsageTotals(goalId: string): ChatUsageResult;

  // —— Check-in 持久化 ——
  patchCheckin(taskId: string, count: number, at: number | null): void;
  patchNudge(taskId: string, count: number, at: number | null): void;
}

/**
 * GoalTask 仓库
 *
 * @deprecated Use ITaskRepo instead
 *
 * 管理 Goal 下的子任务。
 * 复合键: (goalId, taskId)
 */
export interface IGoalTaskRepo extends ITaskRepo {
  /** @deprecated Use getById(taskId) instead */
  get(goalId: string, taskId: string): Promise<GoalTask | null>;
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

/**
 * GoalTodo 仓库
 *
 * 管理 Goal 关联的待办事项。
 * 主键: id
 */
export interface IGoalTodoRepo {
  get(id: string): Promise<GoalTodo | null>;
  findByGoal(goalId: string): Promise<GoalTodo[]>;
  findUndoneByGoal(goalId: string): Promise<GoalTodo[]>;
  save(todo: GoalTodo): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteByGoal(goalId: string): Promise<number>;
}

// ==================== 知识库 ====================

/** 知识库条目 */
export interface KnowledgeBase {
  id: string;
  title: string;
  content: string;             // Markdown 正文
  category: string | null;     // 分类
  tags: string[];              // 标签数组
  project: string;
  source: string | null;       // 来源（关联 Goal / 任务等）
  createdAt: number;
  updatedAt: number;
}

/**
 * 知识库仓库
 *
 * 管理项目经验和教训。
 * 主键: id
 */
export interface IKnowledgeBaseRepo {
  get(id: string): Promise<KnowledgeBase | null>;
  getAll(): Promise<KnowledgeBase[]>;
  save(kb: KnowledgeBase): Promise<void>;
  delete(id: string): Promise<boolean>;

  // —— 查询 ——
  findByProject(project: string): Promise<KnowledgeBase[]>;
  findByCategory(category: string): Promise<KnowledgeBase[]>;
  search(query: string): Promise<KnowledgeBase[]>;
}

// ==================== 新表 Repository 接口（migration 010 引入）====================

/**
 * Channel 仓库
 *
 * 管理 Discord Channel 实体（替代 sessions 表中的 Channel 部分）。
 * 主键: id (Discord Channel ID)
 */
export interface IChannelRepo {
  get(channelId: string): Promise<Channel | null>;
  getByGuild(guildId: string): Promise<Channel[]>;
  getByGuildAndStatus(guildId: string, status: 'active' | 'archived'): Promise<Channel[]>;
  save(channel: Channel): Promise<void>;
  delete(channelId: string): Promise<boolean>;
  archive(channelId: string, userId?: string, reason?: string): Promise<boolean>;
  restore(channelId: string): Promise<boolean>;
  count(status?: 'active' | 'archived'): Promise<number>;
}

/**
 * ClaudeSession 仓库
 *
 * 管理 Claude CLI 会话实体。
 * 主键: claudeSessionId (Claude CLI session_id)
 */
export interface IClaudeSessionRepo {
  get(claudeSessionId: string): ClaudeSession | null;
  getByChannel(channelId: string): ClaudeSession[];
  getActiveByChannel(channelId: string): ClaudeSession | null;
  save(session: ClaudeSession): void;
  close(claudeSessionId: string): boolean;
}

/**
 * SyncCursor 仓库
 *
 * 管理同步游标（跟踪各数据源的同步进度）。
 * 主键: source
 */
export interface ISyncCursorRepo {
  get(source: string): Promise<string | null>;
  set(source: string, cursor: string): Promise<void>;
  delete(source: string): Promise<boolean>;
}

// ==================== Projects ====================

/** 项目实体（对应 projects 表） */
export interface Project {
  /** 项目文件夹名（主键，与业务表 project TEXT 字段一致） */
  name: string;
  /** Discord Guild ID（nullable，Bot 未授权时为 null） */
  guildId: string | null;
  /** Discord Category Channel ID（nullable，未创建时为 null） */
  categoryId: string | null;
  /** Discord 默认 Text Channel ID（nullable，未创建时为 null） */
  channelId: string | null;
  /** 创建时间 (Unix ms) */
  createdAt: number;
  /** 更新时间 (Unix ms) */
  updatedAt: number;
}

/**
 * Project 仓库
 *
 * 管理项目记录（文件系统目录 + Discord 频道绑定）。
 * 主键: name（项目文件夹名）
 */
export interface IProjectRepo {
  get(name: string): Promise<Project | null>;
  getAll(): Promise<Project[]>;
  /** upsert：新建或更新，category_id/channel_id 遵循 COALESCE 不覆盖已有值 */
  upsert(project: Project): Promise<void>;
  delete(name: string): Promise<boolean>;
}

// ==================== Prompt 配置 ====================

/** Prompt 配置（运行时类型） */
export interface PromptConfig {
  key: string;
  category: 'skill' | 'orchestrator';
  name: string;
  description: string | null;
  template: string;
  variables: string[];         // 解析后的变量列表
  parentKey: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Prompt 配置仓库
 *
 * 管理 prompt 模板。
 * 主键: key
 */
export interface IPromptConfigRepo {
  get(key: string): Promise<PromptConfig | null>;
  getAll(): Promise<PromptConfig[]>;
  save(config: PromptConfig): Promise<void>;
  delete(key: string): Promise<boolean>;

  // —— 查询 ——
  findByCategory(category: 'skill' | 'orchestrator'): Promise<PromptConfig[]>;
  findChildren(parentKey: string): Promise<PromptConfig[]>;
}
