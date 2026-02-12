/**
 * SQLite 数据库模型类型定义
 *
 * 这些类型对应 SQLite 表结构，与现有运行时类型（index.ts）对齐。
 * 命名约定：XxxRow = 数据库行类型，Xxx = 运行时/业务类型
 *
 * SQLite 存储约定：
 * - 布尔值用 INTEGER (0/1)
 * - 时间戳用 INTEGER (Unix ms)
 * - JSON 数组/对象用 TEXT (JSON string)
 * - 枚举用 TEXT
 */

// ================================================================
// 枚举类型（与 index.ts 已有枚举对齐）
// ================================================================

/** Goal 状态 */
export type GoalStatus = 'Idea' | 'Active' | 'Paused' | 'Done' | 'Abandoned';

/** Goal 类型 */
export type GoalType = '探索型' | '交付型';

/** Goal Drive 运行状态（已有，re-export 保持一致） */
export type { GoalDriveStatus, GoalTaskStatus, GoalTaskType } from './index.js';

// ================================================================
// sessions 表 — 对应 Session 接口
// ================================================================

export interface SessionRow {
  /** 本地 UUID (PRIMARY KEY) */
  id: string;
  /** 用户自定义名称 */
  name: string;
  /** Discord Channel ID */
  thread_id: string;
  /** Discord Guild ID */
  guild_id: string;
  /** Claude CLI session_id */
  claude_session_id: string | null;
  /** 上一轮 session_id（用于 rewind） */
  prev_claude_session_id: string | null;
  /** 工作目录 */
  cwd: string;
  /** 创建时间 (Unix ms) */
  created_at: number;
  /** 最近一条 Claude 回复 */
  last_message: string | null;
  /** 最近消息时间 (Unix ms) */
  last_message_at: number | null;
  /** 是否处于 plan mode (0/1) */
  plan_mode: number;
  /** 用户选择的 Claude 模型 */
  model: string | null;
  /** 父 Channel ID（fork 产生的子 channel） */
  parent_thread_id: string | null;
  /** worktree 分支名 */
  worktree_branch: string | null;
}

// ================================================================
// message_history 表 — 从 Session.messageHistory 拆出
// ================================================================

export interface MessageHistoryRow {
  /** 自增 ID (PRIMARY KEY) */
  id: number;
  /** 关联的 session UUID (FOREIGN KEY → sessions.id) */
  session_id: string;
  /** 消息角色 */
  role: 'user' | 'assistant';
  /** 消息文本（最多 2000 字符） */
  text: string;
  /** 消息时间 (Unix ms) */
  timestamp: number;
}

// ================================================================
// guilds 表 — 对应 GuildState 接口
// ================================================================

export interface GuildRow {
  /** Discord Guild ID (PRIMARY KEY) */
  guild_id: string;
  /** 默认工作目录 */
  default_cwd: string;
  /** 默认 Claude 模型 */
  default_model: string | null;
  /** 最近活动时间 (Unix ms) */
  last_activity: number;
}

// ================================================================
// archived_sessions 表 — 对应 ArchivedSession 接口
// ================================================================

export interface ArchivedSessionRow extends SessionRow {
  /** 归档时间 (Unix ms) */
  archived_at: number;
  /** 归档操作者 user ID */
  archived_by: string | null;
  /** 归档原因 */
  archive_reason: string | null;
}

// ================================================================
// goals 表 — Goal 元数据 + GoalDriveState
// ================================================================

export interface GoalRow {
  /** UUID (PRIMARY KEY) */
  id: string;
  /** Goal 名称 */
  name: string;
  /** 状态 */
  status: GoalStatus;
  /** 类型 */
  type: GoalType | null;
  /** 所属项目 */
  project: string | null;
  /** 创建日期 (ISO-8601 date, e.g. "2026-02-12") */
  date: string | null;
  /** 完成标准 */
  completion: string | null;
  /** 进度描述 (e.g. "2/6 子任务完成") */
  progress: string | null;
  /** 下一步 */
  next: string | null;
  /** 卡点说明 */
  blocked_by: string | null;
  /** 页面正文 Markdown（完整内容） */
  body: string | null;

  // ---- Drive 状态（Goal 被 drive 时填充）----

  /** Drive 运行状态 */
  drive_status: 'running' | 'paused' | 'completed' | 'failed' | null;
  /** Goal 的 git 分支名 */
  drive_branch: string | null;
  /** 调度员 Discord Thread ID */
  drive_thread_id: string | null;
  /** Drive 的基础工作目录 */
  drive_base_cwd: string | null;
  /** 最大并发子任务数 */
  drive_max_concurrent: number | null;
  /** Drive 创建时间 (Unix ms) */
  drive_created_at: number | null;
  /** Drive 最近更新时间 (Unix ms) */
  drive_updated_at: number | null;
}

// ================================================================
// goal_tasks 表 — 对应 GoalTask 接口
// ================================================================

export interface GoalTaskRow {
  /** 任务 ID，如 "t1", "t2" — Goal 内唯一 */
  id: string;
  /** 所属 Goal ID (FOREIGN KEY → goals.id) */
  goal_id: string;
  /** 任务描述 */
  description: string;
  /** 任务类型 */
  type: '代码' | '手动' | '调研';
  /** 阶段编号 */
  phase: number | null;
  /** 执行状态 */
  status: 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
  /** git 分支名 */
  branch_name: string | null;
  /** 对应的 Discord Thread ID */
  thread_id: string | null;
  /** 派发时间 (Unix ms) */
  dispatched_at: number | null;
  /** 完成时间 (Unix ms) */
  completed_at: number | null;
  /** 错误信息 */
  error: string | null;
  /** 是否已合并 (0/1) */
  merged: number;
  /** 是否已通知阻塞 (0/1) */
  notified_blocked: number;
}

// ================================================================
// goal_task_deps 表 — GoalTask.depends 多对多关系
// ================================================================

export interface GoalTaskDepRow {
  /** 任务 ID (FOREIGN KEY → goal_tasks) */
  task_id: string;
  /** 所属 Goal ID (FOREIGN KEY → goals.id) */
  goal_id: string;
  /** 依赖的任务 ID */
  depends_on_task_id: string;
}

// ================================================================
// devlogs 表
// ================================================================

export interface DevLogRow {
  /** UUID (PRIMARY KEY) */
  id: string;
  /** 功能标题（中文，10字以内） */
  name: string;
  /** 日期 (ISO-8601 date) */
  date: string;
  /** 项目名 */
  project: string;
  /** 分支名 */
  branch: string | null;
  /** 功能概括 */
  summary: string | null;
  /** commit 数量 */
  commits: number | null;
  /** diff stat 原文 */
  lines_changed: string | null;
  /** 关联 Goal 名称 */
  goal: string | null;
  /** 页面正文 Markdown */
  body: string | null;
  /** 创建时间 (Unix ms) */
  created_at: number;
}

// ================================================================
// ideas 表
// ================================================================

export interface IdeaRow {
  /** UUID (PRIMARY KEY) */
  id: string;
  /** 想法标题 */
  name: string;
  /** 状态 */
  status: string;
  /** 项目名 */
  project: string;
  /** 日期 (ISO-8601 date) */
  date: string;
  /** 创建时间 (Unix ms) */
  created_at: number;
  /** 更新时间 (Unix ms) */
  updated_at: number;
}

// ================================================================
// 运行时类型转换辅助
// ================================================================

import type {
  Session,
  GuildState,
  ArchivedSession,
  GoalDriveState,
  GoalTask,
} from './index.js';

/** Session → SessionRow */
export type SessionToRow = (session: Session) => SessionRow;

/** SessionRow → Session（需要额外查询 message_history） */
export type RowToSession = (row: SessionRow, history: MessageHistoryRow[]) => Session;

/** GuildState → GuildRow */
export type GuildStateToRow = (guild: GuildState) => GuildRow;

/** GuildRow → GuildState */
export type RowToGuildState = (row: GuildRow) => GuildState;

/** GoalDriveState → GoalRow + GoalTaskRow[] + GoalTaskDepRow[] */
export type GoalDriveStateToRows = (state: GoalDriveState) => {
  goal: Partial<GoalRow>;
  tasks: GoalTaskRow[];
  deps: GoalTaskDepRow[];
};

/** GoalRow + GoalTaskRow[] + GoalTaskDepRow[] → GoalDriveState */
export type RowsToGoalDriveState = (
  goal: GoalRow,
  tasks: GoalTaskRow[],
  deps: GoalTaskDepRow[],
) => GoalDriveState;
