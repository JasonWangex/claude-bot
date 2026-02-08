/**
 * Telegram Bot 类型定义
 */

// 会话
export interface Session {
  id: string;                // 本地 UUID
  name: string;              // 用户自定义名称
  claudeSessionId?: string;  // Claude CLI session_id
  cwd: string;
  createdAt: number;
  lastMessage?: string;      // 最近一条 Claude 回复
  lastMessageAt?: number;
  messageHistory: Array<{    // 最近 50 条消息记录
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
}

// Telegram 用户状态
export interface UserState {
  sessions: Session[];
  activeSessionId: string;   // 指向 Session.id
  lastActivity: number;
  authorized: boolean;
}

// Claude Code stream-json 事件
export interface StreamEvent {
  type: 'system' | 'assistant' | 'result';
  subtype?: string;
  session_id?: string;
  // assistant event
  message?: {
    role: string;
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      name?: string;      // tool name
      input?: any;
    }>;
  };
  // result event
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Claude Code 最终响应
export interface ClaudeResponse {
  session_id: string;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// 进度回调
export type ProgressCallback = (event: StreamEvent) => void;

// Claude Code 调用选项
export interface ClaudeOptions {
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  lockKey?: string;
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
