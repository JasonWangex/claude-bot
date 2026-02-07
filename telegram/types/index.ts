/**
 * Telegram Bot 类型定义
 */

// Telegram 用户状态
export interface UserState {
  sessionId?: string;  // Claude Code 会话 ID
  cwd: string;         // 当前工作目录
  lastActivity: number; // 最后活动时间
  authorized: boolean; // 是否已鉴权
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
