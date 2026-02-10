/**
 * Telegram Bot 类型定义
 */

// 会话
export interface Session {
  id: string;                // 本地 UUID
  name: string;              // 用户自定义名称
  topicId: number;            // Telegram message_thread_id
  groupId: number;            // Telegram Group chat ID
  claudeSessionId?: string;  // Claude CLI session_id
  prevClaudeSessionId?: string; // 上一轮 session_id（用于 rewind）
  cwd: string;
  createdAt: number;
  lastMessage?: string;      // 最近一条 Claude 回复
  lastMessageAt?: number;
  planMode?: boolean;        // 是否处于 plan mode 等待确认
  model?: string;            // 用户选择的 Claude 模型（如 claude-sonnet-4-5-20250929）
  messageHistory: Array<{    // 最近 50 条消息记录
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
  parentTopicId?: number;     // 父 Topic ID（fork 产生的子 topic）
  worktreeBranch?: string;    // worktree 分支名（fork 创建的）
  iconColor?: number;         // Forum Topic 图标颜色
  iconCustomEmojiId?: string; // Forum Topic 自定义 emoji 图标 ID
}

// Group 状态
export interface GroupState {
  groupId: number;
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

// compact 元数据
export interface CompactMetadata {
  trigger: 'auto' | 'manual';
  pre_tokens: number;
}

// Claude Code stream-json 事件
export interface StreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  session_id?: string;
  // compact 相关
  status?: string | null;           // 'compacting' | null
  compact_metadata?: CompactMetadata;
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
  RECOVERABLE = 'recoverable',                  // 超时/崩溃 → 重试一次
  SESSION_RECOVERABLE = 'session_recoverable',   // 上下文溢出 → 清除 session 重试
  FATAL = 'fatal',                               // CLI 不可用 → 不重试
  ABORTED = 'aborted',                           // 用户主动中断
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
  contextWindow?: number;       // 模型的 context window 大小（从 result.modelUsage 获取）
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
  outputFile: string;     // JSONL 输出文件路径
  stderrFile: string;     // stderr 输出文件路径
  groupId: number;
  topicId: number;
  lockKey: string;
  claudeSessionId?: string;
  cwd?: string;
  startTime: number;
}

// 重连结果
export interface ReconnectedResult {
  groupId: number;
  topicId: number;
  lockKey: string;
  claudeSessionId?: string;
  status: 'completed' | 'running' | 'failed';
  result?: string;
  usage?: { input_tokens: number; output_tokens: number };
  duration_ms?: number;
  total_cost_usd?: number;
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
  groupId?: number;
  topicId?: number;
}

// Telegram Bot 配置
export interface TelegramBotConfig {
  telegramToken: string;
  defaultWorkDir: string;
  claudeCliPath: string;
  maxTurns: number;
  commandTimeout: number;
  accessToken: string;
  authorizedChatId?: number;
  projectsRoot: string;                    // 项目主目录（所有 Topic 工作目录的父目录）
  autoCreateProjectDir: boolean;           // 是否自动创建不存在的项目目录
  topicDirNaming: 'kebab-case' | 'snake_case' | 'original';  // Topic 工作目录命名策略
  worktreesDir: string;                    // worktree 存放目录
  apiPort: number;                          // 本地 HTTP API 端口（0 = 禁用）
}

// Topic 归档会话
export interface ArchivedSession extends Session {
  archivedAt: number;        // 归档时间戳
  archivedBy?: number;       // 归档操作者 user ID
  archiveReason?: string;    // 归档原因
}
