/**
 * Discord Bot 类型定义
 */

// Re-export repository interfaces and related types
export type {
  Goal,
  GoalStatus,
  GoalType,
  DevLog,
  Idea,
  IGuildRepo,
  IGoalRepo,
  ITaskRepo,
  IGoalTaskRepo,
  IDevLogRepo,
  IIdeaRepo,
} from './repository.js';
export { IdeaStatus, IdeaType } from './repository.js';

// 会话（内存状态，用 channelId 标识）
export interface Session {
  name: string;              // 用户自定义名称
  channelId: string;         // Discord Channel ID (Text Channel under Category)
  guildId: string;           // Discord Guild ID
  claudeSessionId?: string;  // Claude CLI session_id (当前活跃)
  prevClaudeSessionId?: string; // 上一轮 session_id（用于 rewind）

  cwd: string;
  createdAt: number;
  lastMessage?: string;      // 最近一条 Claude 回复
  lastMessageAt?: number;
  planMode?: boolean;        // 是否处于 plan mode 等待确认
  model?: string;            // 用户选择的 Claude 模型
  effort?: string;           // Claude CLI effort level (low/medium/high/max)
  messageCount: number;       // 消息历史条数（从 DB message_count 字段）
  parentChannelId?: string;   // 父 Channel ID（fork 产生的子 channel）
  worktreeBranch?: string;    // worktree 分支名（fork 创建的）
  hidden?: boolean;           // true = audit session，无对应 Discord channel，不在 web UI 显示
}

// Guild 状态
export interface GuildState {
  guildId: string;
  defaultCwd: string;
  defaultModel?: string;
  lastActivity: number;
}

// structured patch from Write/Edit tool results
export interface StructuredPatch {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// 收集的文件变更
export interface FileChange {
  filePath: string;
  type: 'update' | 'create';
  patches?: StructuredPatch[];
  content?: string;   // 新建文件的完整内容
}

// tool_use_result for file operations
export interface FileToolResult {
  type: 'update' | 'create';
  filePath: string;
  content?: string;
  structuredPatch?: StructuredPatch[];
  originalFile?: string;
}

// compact 元数据（compact_boundary 事件）
export interface CompactMetadata {
  trigger: 'auto' | 'manual';
  pre_tokens: number;
}

// microcompact 元数据（microcompact_boundary 事件）
export interface MicrocompactMetadata {
  trigger: 'auto' | 'manual';
  preTokens: number;
  tokensSaved: number;
  compactedToolIds?: string[];
  clearedAttachmentUUIDs?: string[];
}

// Claude Code stream-json 事件
export interface StreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  session_id?: string;
  // compact 相关
  // status 事件: {type:"system", subtype:"status", status:"compacting"|null}
  status?: string | null;
  compact_metadata?: CompactMetadata;
  microcompact_metadata?: MicrocompactMetadata;
  // assistant event
  message?: {
    role: string;
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
      id?: string;        // tool_use block ID
      text?: string;
      thinking?: string;  // thinking block content
      name?: string;      // tool name
      input?: any;
    }>;
  };
  // user event (tool results)
  tool_use_result?: FileToolResult & Record<string, any>;
  // result event
  result?: string;
  is_error?: boolean;
  errors?: string[];
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    contextWindow: number;
    maxOutputTokens: number;
    costUSD?: number;
  }>;
}

// 错误分类
export enum ClaudeErrorType {
  RECOVERABLE = 'recoverable',
  SESSION_RECOVERABLE = 'session_recoverable',
  FATAL = 'fatal',
  ABORTED = 'aborted',
  PROCESS_KILLED = 'process_killed',
  AUTH_ERROR = 'auth_error',  // 403 认证错误，由上层拦截器处理自动重试
  API_ERROR = 'api_error',    // 500 服务端错误，由上层拦截器处理退避重试（最多 5 次）
}

export class ClaudeExecutionError extends Error {
  errorType: ClaudeErrorType;
  /** ABORTED 时携带的 session ID，供上层在 abort 后保留会话以便下次 resume */
  sessionId?: string;
  constructor(message: string, errorType: ClaudeErrorType, sessionId?: string) {
    super(message);
    this.name = 'ClaudeExecutionError';
    this.errorType = errorType;
    this.sessionId = sessionId;
  }
}

// Claude Code 最终响应
export interface ClaudeResponse {
  session_id: string;
  result: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  contextWindow?: number;
}

/** 单次 Claude 调用的 token/cost/time 汇总 */
export interface ChatUsageResult {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
}

// 进度回调
export type ProgressCallback = (event: StreamEvent) => void;

// AskUserQuestion 工具的输入结构
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
}

// ExitPlanMode 工具的输入结构
export interface ExitPlanModeInput {
  allowedPrompts?: Array<{
    tool: string;
    prompt: string;
  }>;
}

// 进程注册表条目（用于 Bot 重启后重连）
export interface ProcessRegistryEntry {
  pid: number;
  outputFile: string;
  stderrFile: string;
  guildId: string;
  channelId: string;
  lockKey: string;
  claudeSessionId?: string;
  cwd?: string;
  startTime: number;
}

// 重连结果
export interface ReconnectedResult {
  guildId: string;
  channelId: string;
  lockKey: string;
  claudeSessionId?: string;
  status: TaskStatus.Completed | TaskStatus.Running | TaskStatus.Failed;
  result?: string;
  usage?: { input_tokens: number; output_tokens: number };
  duration_ms?: number;
  total_cost_usd?: number;
}

// 图片附件（base64 编码）
export interface ImageAttachment {
  data: string;        // base64 encoded
  mediaType: string;   // image/jpeg | image/png
}

// Claude Code 调用选项
export interface ClaudeOptions {
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  /**
   * 延迟解析 session ID 的回调：在 lock 获取后（即前一个任务结束后）调用，
   * 返回值覆盖 resume，解决排队消息创建新 session 的问题。
   * 仅在请求等待了队列（waited=true）时才调用。
   */
  resolveSessionId?: () => string | undefined;
  lockKey?: string;
  permissionMode?: string;
  forkSession?: boolean;
  model?: string;
  effort?: string;
  guildId?: string;
  channelId?: string;
  images?: ImageAttachment[];
  appendSystemPrompt?: string;
}

// Discord Bot 配置
export interface DiscordBotConfig {
  discordToken: string;
  applicationId: string;
  defaultWorkDir: string;
  claudeCliPath: string;
  maxTurns: number;
  commandTimeout: number;
  stallTimeout: number;
  accessToken: string;
  authorizedGuildId?: string;
  generalChannelId?: string;
  botLogsChannelId?: string;
  lostAndFoundChannelId?: string;
  projectsRoot: string;
  autoCreateProjectDir: boolean;
  topicDirNaming: 'kebab-case' | 'snake_case' | 'original';
  worktreesDir: string;
  apiPort: number;
  apiListen: string;
  // 多模型流水线配置
  pipelineOpusModel: string;
  pipelineSonnetModel: string;
}

// ========== Goal Orchestrator ==========

export enum GoalDriveStatus {
  Running   = 'running',
  Paused    = 'paused',
  Completed = 'completed',
  Failed    = 'failed',
}

export enum TaskStatus {
  Pending         = 'pending',
  Dispatched      = 'dispatched',
  Running         = 'running',
  Completed       = 'completed',
  Failed          = 'failed',
  Blocked         = 'blocked',
  BlockedFeedback = 'blocked_feedback',
  Paused          = 'paused',
  Cancelled       = 'cancelled',
  Skipped         = 'skipped',
}

export enum TaskType {
  Code        = '代码',
  Manual      = '手动',
  Research    = '调研',
  Placeholder = '占位',
  Test        = '测试',
}

export enum FeedbackType {
  Blocked = 'blocked',
  Clarify = 'clarify',
  Replan  = 'replan',
}

/** Feedback 文件内容结构（feedback/<taskId>.json） */
export interface TaskFeedback {
  type: FeedbackType;  // e.g. 'blocked' | 'clarify' | 'replan'
  reason: string;      // 简短原因
  details?: string;    // 详细说明
}

export enum TaskComplexity {
  Simple  = 'simple',
  Complex = 'complex',
}

export enum PipelinePhase {
  Execute  = 'execute',
  Conflict = 'conflict',
}

/** Task review 裁决（reviewer session 的输出） */
export enum TaskReviewVerdict {
  Pass   = 'pass',
  Replan = 'replan',
}

/** 失败任务的 tech lead 裁决 */
export enum FailedTaskVerdict {
  Retry        = 'retry',
  Replan       = 'replan',
  EscalateUser = 'escalate_user',
  Skip         = 'skip',
}

/** Feedback 调查结论（AI 调查后的行动决策） */
export enum FeedbackInvestigationAction {
  Continue = 'continue',
  Retry    = 'retry',
  Replan   = 'replan',
  Escalate = 'escalate',
}

/** Phase 评估决策 */
export enum PhaseDecision {
  Continue = 'continue',
  Replan   = 'replan',
}

export interface Task {
  id: string;
  goalId?: string | null;  // 关联 Goal（null 表示独立任务）
  description: string;
  type: TaskType;
  phase?: number;

  // 多模型流水线
  complexity?: TaskComplexity;   // 代码任务复杂度，Goal 创建时标注
  pipelinePhase?: PipelinePhase; // 当前阶段: 'execute'
  auditRetries?: number;         // audit-fix 循环重试计数（最多 3）
  auditSessionKey?: string;      // per-task audit session 的虚拟 channelId（'audit-{taskId}'），持久化后重启可恢复

  // 执行状态
  status: TaskStatus;
  branchName?: string;
  channelId?: string;         // 对应的 Discord Channel ID
  dispatchedAt?: number;
  completedAt?: number;
  error?: string;
  merged?: boolean;
  notifiedBlocked?: boolean;
  feedback?: TaskFeedback;    // 来自 feedback/<taskId>.json 的反馈内容

  // Token/cost/time tracking（pipeline 各阶段累加）
  tokensIn?: number;
  tokensOut?: number;
  cacheReadIn?: number;
  cacheWriteIn?: number;
  costUsd?: number;
  durationMs?: number;

  // 详细计划（从 Goal body 解析后存储）
  detailPlan?: string;

  // 元数据（用于存储扩展信息）
  metadata?: Record<string, any>;

  // Check-in 持久化字段
  checkinCount?: number;
  lastCheckinAt?: number | null;
  nudgeCount?: number;
  lastNudgeAt?: number | null;
}

// ========== Deprecated aliases ==========
/** @deprecated Use TaskStatus */
export { TaskStatus as GoalTaskStatus };
/** @deprecated Use TaskType */
export { TaskType as GoalTaskType };
/** @deprecated Use TaskFeedback */
export type GoalTaskFeedback = TaskFeedback;
/** @deprecated Use TaskComplexity */
export { TaskComplexity as GoalTaskComplexity };
/** @deprecated Use PipelinePhase */
export { PipelinePhase as GoalPipelinePhase };
/** @deprecated Use Task */
export type GoalTask = Task;

export interface GoalDriveState {
  goalId: string;
  goalSeq: number;            // 短序号，用于子任务命名前缀（g1, g2, ...）
  goalName: string;
  branch: string;
  channelId: string;          // 调度员 channel（用于通知用户）
  techLeadChannelId?: string; // Tech Lead 专用 channel（Opus 实例运行在此，负责审查、冲突解决、阶段评估）
  phaseMilestones?: Record<string, string>; // Phase 里程碑映射 {phaseNumber: milestone}
  /** Phase evaluation 待决状态。非 null 表示 tech lead 已收到 prompt 但尚未写回事件，供扫描器检测并重推。 */
  pendingPhaseEval?: { phase: number; phaseTaskId: string; triggeredAt: number; nudgeCount: number };
  cwd: string;
  status: GoalDriveStatus;
  createdAt: number;
  updatedAt: number;
  maxConcurrent: number;

  tasks: Task[];
}

// Thread 归档会话
export interface ArchivedSession extends Session {
  archivedAt: number;
  archivedBy?: string;       // 归档操作者 user ID (string)
  archiveReason?: string;
}

// ================================================================
// 新表类型（migration 010 引入）
// ================================================================

// Channel（Discord Text Channel 实体）
export interface Channel {
  id: string;               // Discord Channel ID
  guildId: string;
  name: string;
  cwd: string;
  worktreeBranch?: string;
  parentChannelId?: string;
  status: 'active' | 'archived';
  archivedAt?: number;
  archivedBy?: string;
  archiveReason?: string;
  messageCount: number;
  createdAt: number;
  lastMessage?: string;
  lastMessageAt?: number;
  hidden?: boolean;         // true = 内部虚拟 channel（audit session 等），无对应 Discord channel
}

/** 每个模型的分项 token/cost 统计 */
export interface ModelUsageEntry {
  tokensIn: number;
  tokensOut: number;
  cacheReadIn: number;
  cacheWriteIn: number;
  costUsd: number;
  turnCount: number;
}

// ClaudeSession（Claude Code CLI 会话实体，PK = claudeSessionId）
export interface ClaudeSession {
  claudeSessionId: string;   // Claude CLI session_id (PK)
  prevClaudeSessionId?: string;
  channelId?: string;
  model?: string;
  effort?: string;
  planMode: boolean;
  status: 'active' | 'waiting' | 'idle' | 'closed';  // 扩展状态支持
  createdAt: number;
  closedAt?: number;
  purpose?: 'channel' | 'plan' | 'temp';  // 会话用途
  parentSessionId?: string;  // 父会话 CLI session_id
  lastActivityAt?: number;   // 最后活动时间（用于超时监控）
  lastUsageJson?: string;    // 最后一次 token/cost 数据（JSON string）
  lastStopAt?: number;       // 最后一次 Stop 事件时间（幂等窗口）
  title?: string;            // LLM 自动生成的标题
  taskId?: string;           // 关联 Task ID
  goalId?: string;           // 关联 Goal ID
  cwd?: string;              // 工作目录
  gitBranch?: string;        // Git 分支
  projectPath?: string;      // Claude 项目路径（从 JSONL 文件目录还原）

  // Session 级 token/cost 累计统计
  tokensIn?: number;
  tokensOut?: number;
  cacheReadIn?: number;
  cacheWriteIn?: number;
  costUsd?: number;
  turnCount?: number;
  usageFileOffset?: number;
  modelUsage?: Record<string, ModelUsageEntry>;  // 每模型分项统计
  hidden?: boolean;          // true = audit session，不在 web UI 显示（对应 claude_sessions.hidden）
}
