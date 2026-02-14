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
export type GoalStatus = 'Pending' | 'Collecting' | 'Planned' | 'Processing' | 'Blocking' | 'Completed' | 'Merged';

/** Goal 类型 */
export type GoalType = '探索型' | '交付型';

/** Goal Drive 运行状态（已有，re-export 保持一致） */
export type { GoalDriveStatus, GoalTaskStatus, GoalTaskType } from './index.js';

// ================================================================
// sessions 表 — 对应 Session 接口
// @deprecated - 将被 ChannelRow + ClaudeSessionRow 替代（migration 010）
// ================================================================

export interface SessionRow {
  /** 本地 UUID (PRIMARY KEY) */
  id: string;
  /** 用户自定义名称 */
  name: string;
  /** Discord Channel ID (DB 列名仍为 thread_id) */
  thread_id: string;
  /** Discord Guild ID */
  guild_id: string;
  /** Claude CLI session_id (当前活跃) */
  claude_session_id: string | null;
  /** 上一轮 session_id（用于 rewind） */
  prev_claude_session_id: string | null;
  /** 按模型分槽的 session IDs (JSON) */
  session_ids_json: string | null;
  /** 按模型分槽的 prev session IDs (JSON, 用于 rewind) */
  prev_session_ids_json: string | null;
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
  /** 父 Channel ID（fork 产生的子 channel，DB 列名仍为 parent_thread_id） */
  parent_thread_id: string | null;
  /** worktree 分支名 */
  worktree_branch: string | null;
  /** 消息历史条数（替代 messageHistory.length） */
  message_count: number;
}

// ================================================================
// message_history 表已废弃 (migration 006)
// ================================================================

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
// @deprecated - 将被 ChannelRow (status='archived') 替代（migration 010）
// ================================================================

export interface ArchivedSessionRow extends SessionRow {
  /** 归档时间 (Unix ms) */
  archived_at: number;
  /** 归档操作者 user ID */
  archived_by: string | null;
  /** 归档原因 */
  archive_reason: string | null;
  /** 归档时的消息历史 (JSON 序列化) */
  message_history_json: string | null;
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
  /** 人类可读的短序号（g1, g2, ...），用于子任务命名前缀 */
  seq: number | null;

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
  /** JSON: pendingReplan + pendingRollback（重启恢复用） */
  drive_pending_json: string | null;
}

// ================================================================
// goal_tasks 表 — 对应 GoalTask 接口
// @deprecated - 已重命名为 TaskRow（migration 010）
// Use TaskRow instead
// ================================================================

/** @deprecated Use TaskRow from migration 010 */
export interface GoalTaskRow {
  /** 任务 ID，如 "t1", "t2" — Goal 内唯一。对外命名时带 goal seq 前缀如 "g2t1" */
  id: string;
  /** 所属 Goal ID (FOREIGN KEY → goals.id) */
  goal_id: string;
  /** 任务描述 */
  description: string;
  /** 任务类型 */
  type: '代码' | '手动' | '调研' | '占位';
  /** 阶段编号 */
  phase: number | null;
  /** 代码任务复杂度 */
  complexity: 'simple' | 'complex' | null;
  /** 当前流水线阶段 */
  pipeline_phase: string | null;
  /** audit 重试计数 */
  audit_retries: number;
  /** 执行状态 */
  status: 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'blocked_feedback' | 'paused' | 'cancelled' | 'skipped';
  /** git 分支名 */
  branch_name: string | null;
  /** 对应的 Discord Thread ID */
  channel_id: string | null;
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
  /** JSON: GoalTaskFeedback（feedback/<taskId>.json 的内容） */
  feedback_json: string | null;

  // Token/cost/time tracking
  /** 累计输入 token */
  tokens_in: number | null;
  /** 累计输出 token */
  tokens_out: number | null;
  /** 累计缓存读取 token */
  cache_read_in: number | null;
  /** 累计缓存写入 token */
  cache_write_in: number | null;
  /** 累计成本（美元） */
  cost_usd: number | null;
  /** 累计 Claude 执行时间（ms） */
  duration_ms: number | null;
}

// ================================================================
// goal_task_deps 表 — GoalTask.depends 多对多关系
// @deprecated - 已重命名为 TaskDepRow（migration 010）
// Use TaskDepRow instead
// ================================================================

/** @deprecated Use TaskDepRow from migration 010 */
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
// goal_checkpoints 表 — 对应 GoalCheckpoint 接口
// ================================================================

export interface GoalCheckpointRow {
  /** UUID (PRIMARY KEY) */
  id: string;
  /** 所属 Goal ID (FOREIGN KEY → goals.id) */
  goal_id: string;
  /** 触发方式，如 'task_complete' | 'manual' | 'phase_change' */
  trigger: string;
  /** 触发任务 ID（可选） */
  trigger_task_id: string | null;
  /** 触发原因 */
  reason: string | null;
  /** 任务列表快照 (JSON) */
  tasks_snapshot: string | null;
  /** git 引用（commit hash 或 branch） */
  git_ref: string | null;
  /** 变更摘要 */
  change_summary: string | null;
  /** 创建时间 (Unix ms) */
  created_at: number;
}

// ================================================================
// interaction_log 表 — 存储每轮交互的结构化摘要
// ================================================================

export interface InteractionLogRow {
  /** 自增 ID (PRIMARY KEY) */
  id: number;
  /** Claude CLI session_id */
  session_id: string;
  /** 交互轮次索引（从 0 开始） */
  turn_index: number;
  /** 消息角色 */
  role: 'user' | 'assistant';
  /** 内容类型（如 'text', 'tool_use', 'tool_result'） */
  content_type: string | null;
  /** 摘要文本（精简内容，如工具名、简短消息等） */
  summary_text: string | null;
  /** Claude 模型名称 */
  model: string | null;
  /** 输入 token 数 */
  tokens_input: number | null;
  /** 输出 token 数 */
  tokens_output: number | null;
  /** 成本（美元） */
  cost_usd: number | null;
  /** JSONL 文件路径（相对于项目根目录） */
  jsonl_path: string | null;
  /** 创建时间 (Unix ms) */
  created_at: number;
}

// ================================================================
// knowledge_base 表
// ================================================================

export interface KnowledgeBaseRow {
  /** UUID (PRIMARY KEY) */
  id: string;
  /** 标题 */
  title: string;
  /** Markdown 正文 */
  content: string;
  /** 分类 (如 Architecture, Troubleshooting, API, Design) */
  category: string | null;
  /** 标签 (JSON 数组) */
  tags: string | null;
  /** 项目名 */
  project: string;
  /** 来源 (如关联的 Goal 名称或任务) */
  source: string | null;
  /** 创建时间 (Unix ms) */
  created_at: number;
  /** 更新时间 (Unix ms) */
  updated_at: number;
}

// ================================================================
// channels 表
// ================================================================

export interface ChannelRow {
  id: string;                    // Discord Channel ID (PK)
  guild_id: string;
  name: string;
  cwd: string;
  worktree_branch: string | null;
  parent_channel_id: string | null;
  status: 'active' | 'archived';
  archived_at: number | null;
  archived_by: string | null;
  archive_reason: string | null;
  message_count: number;
  created_at: number;
  last_message: string | null;
  last_message_at: number | null;
}

// ================================================================
// claude_sessions 表
// ================================================================

export interface ClaudeSessionRow {
  id: string;                    // UUID (PK)
  claude_session_id: string | null;
  prev_claude_session_id: string | null;
  channel_id: string | null;
  model: string | null;
  plan_mode: number;             // 0/1
  status: 'active' | 'closed';
  created_at: number;
  closed_at: number | null;
}

// ================================================================
// channel_session_links 表
// ================================================================

export interface ChannelSessionLinkRow {
  channel_id: string;
  claude_session_id: string;
  linked_at: number;
  unlinked_at: number | null;
}

// ================================================================
// sync_cursors 表
// ================================================================

export interface SyncCursorRow {
  source: string;
  cursor: string;
  updated_at: number;
}

// ================================================================
// tasks 表（原 goal_tasks）
// ================================================================

export interface TaskRow {
  id: string;                    // 全局唯一 PK
  goal_id: string | null;       // nullable
  description: string;
  type: '代码' | '手动' | '调研' | '占位';
  phase: number | null;
  complexity: 'simple' | 'complex' | null;
  pipeline_phase: string | null;
  audit_retries: number;
  status: string;
  branch_name: string | null;
  channel_id: string | null;    // 替代 thread_id
  dispatched_at: number | null;
  completed_at: number | null;
  error: string | null;
  merged: number;
  notified_blocked: number;
  feedback_json: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_in: number | null;
  cache_write_in: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

// ================================================================
// task_deps 表（原 goal_task_deps）
// ================================================================

export interface TaskDepRow {
  task_id: string;
  depends_on_task_id: string;
  goal_id: string | null;
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

/** SessionRow → Session */
export type RowToSession = (row: SessionRow) => Session;

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
