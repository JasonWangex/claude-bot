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
  IdeaStatus,
  ISessionRepo,
  IGuildRepo,
  IGoalRepo,
  IGoalMetaRepo,
  IGoalTaskRepo,
  IGoalCheckpointRepo,
  IDevLogRepo,
  IIdeaRepo,
} from './repository.js';

// 会话
export interface Session {
  id: string;                // 本地 UUID
  name: string;              // 用户自定义名称
  threadId: string;          // Discord Channel ID (Text Channel under Category)
  guildId: string;           // Discord Guild ID
  claudeSessionId?: string;  // Claude CLI session_id
  prevClaudeSessionId?: string; // 上一轮 session_id（用于 rewind）
  cwd: string;
  createdAt: number;
  lastMessage?: string;      // 最近一条 Claude 回复
  lastMessageAt?: number;
  planMode?: boolean;        // 是否处于 plan mode 等待确认
  model?: string;            // 用户选择的 Claude 模型
  messageHistory: Array<{    // 最近 50 条消息记录
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
  messageCount: number;       // 消息历史条数（从 DB message_count 字段）
  parentThreadId?: string;    // 父 Channel ID（fork 产生的子 channel）
  worktreeBranch?: string;    // worktree 分支名（fork 创建的）
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
      type: 'text' | 'tool_use' | 'tool_result';
      id?: string;        // tool_use block ID
      text?: string;
      name?: string;      // tool name
      input?: any;
    }>;
  };
  // user event (tool results)
  tool_use_result?: FileToolResult & Record<string, any>;
  // result event
  result?: string;
  is_error?: boolean;
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
}

export class ClaudeExecutionError extends Error {
  errorType: ClaudeErrorType;
  constructor(message: string, errorType: ClaudeErrorType) {
    super(message);
    this.name = 'ClaudeExecutionError';
    this.errorType = errorType;
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
  threadId: string;
  lockKey: string;
  claudeSessionId?: string;
  cwd?: string;
  startTime: number;
}

// 重连结果
export interface ReconnectedResult {
  guildId: string;
  threadId: string;
  lockKey: string;
  claudeSessionId?: string;
  status: 'completed' | 'running' | 'failed';
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
  lockKey?: string;
  permissionMode?: string;
  forkSession?: boolean;
  model?: string;
  guildId?: string;
  threadId?: string;
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

export type GoalDriveStatus = 'running' | 'paused' | 'completed' | 'failed';
export type GoalTaskStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'blocked_feedback' | 'paused' | 'cancelled' | 'skipped';
export type GoalTaskType = '代码' | '手动' | '调研' | '占位';

/** Feedback 文件内容结构（feedback/<taskId>.json） */
export interface GoalTaskFeedback {
  type: string;        // e.g. 'needs_revision' | 'question' | 'blocked'
  reason: string;      // 简短原因
  details?: string;    // 详细说明
}

export type GoalTaskComplexity = 'simple' | 'complex';
export type GoalPipelinePhase = 'plan' | 'execute' | 'audit' | 'fix';

export interface GoalTask {
  id: string;
  description: string;
  type: GoalTaskType;
  depends: string[];
  phase?: number;

  // 多模型流水线
  complexity?: GoalTaskComplexity;   // 代码任务复杂度，Goal 创建时标注
  pipelinePhase?: GoalPipelinePhase; // 当前阶段: 'plan' | 'execute' | 'audit' | 'fix'
  auditRetries?: number;             // audit 重试计数（最多 2）

  // 执行状态
  status: GoalTaskStatus;
  branchName?: string;
  threadId?: string;          // 对应的 Discord Thread ID
  dispatchedAt?: number;
  completedAt?: number;
  error?: string;
  merged?: boolean;
  notifiedBlocked?: boolean;
  feedback?: GoalTaskFeedback; // 来自 feedback/<taskId>.json 的反馈内容
}

/** 待审批的 Replan 变更 */
export interface PendingReplan {
  changes: Array<Record<string, any>>;  // ReplanChange[] — 避免循环依赖用 Record
  reasoning: string;
  impactLevel: 'low' | 'medium' | 'high';
  checkpointId: string;
}

/** 待用户确认的回滚操作 */
export interface PendingRollback {
  checkpointId: string;
  /** 被暂停的受影响任务（回滚前状态为 running/dispatched 的任务） */
  pausedTaskIds: string[];
  /** 成本评估摘要 */
  costSummary: string;
  /** 受影响任务详情 */
  affectedTasks: Array<{
    id: string;
    description: string;
    previousStatus: GoalTaskStatus;
    runtime?: number;        // 运行时长 ms
    diffStat?: string;       // git diff --stat 输出
  }>;
  createdAt: number;
}

export interface GoalDriveState {
  goalId: string;
  goalSeq: number;            // 短序号，用于子任务命名前缀（g1, g2, ...）
  goalName: string;
  goalBranch: string;
  goalThreadId: string;       // 调度员 thread（用于通知用户）
  baseCwd: string;
  status: GoalDriveStatus;
  createdAt: number;
  updatedAt: number;
  maxConcurrent: number;

  tasks: GoalTask[];

  /** 待用户审批的高影响 replan 变更（仅 impactLevel=high 时有值） */
  pendingReplan?: PendingReplan;

  /** 待用户确认的回滚操作 */
  pendingRollback?: PendingRollback;
}

// Goal 快照检查点
export interface GoalCheckpoint {
  id: string;
  goalId: string;
  trigger: string;
  triggerTaskId?: string;
  reason?: string;
  tasksSnapshot?: GoalTask[];
  gitRef?: string;
  changeSummary?: string;
  createdAt: number;
}

// Thread 归档会话
export interface ArchivedSession extends Session {
  archivedAt: number;
  archivedBy?: string;       // 归档操作者 user ID (string)
  archiveReason?: string;
}
