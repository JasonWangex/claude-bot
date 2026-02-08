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
  messageHistory: Array<{    // 最近 50 条消息记录
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
}

// Group 状态
export interface GroupState {
  groupId: number;
  defaultCwd: string;
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
  };
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
  };
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

// Claude Code 调用选项
export interface ClaudeOptions {
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  lockKey?: string;
  permissionMode?: string;
  forkSession?: boolean;
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
}
