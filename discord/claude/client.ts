/**
 * Claude Code 客户端 - 高级接口（含重试逻辑）
 */

import { ClaudeExecutor } from './executor.js';
import { ClaudeOptions, ProgressCallback, ClaudeErrorType, ClaudeExecutionError, ReconnectedResult } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface ChatResult {
  result: string;
  sessionId: string;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  duration_ms?: number;
  total_cost_usd?: number;
  contextWindow?: number;
}

export class ClaudeClient {
  private executor: ClaudeExecutor;
  private defaultAllowedTools: string[];
  private maxTurns: number;

  constructor(
    claudeCliPath: string = 'claude',
    commandTimeout: number = 300000,
    maxTurns: number = 20,
    stallTimeout: number = 60000
  ) {
    this.executor = new ClaudeExecutor(claudeCliPath, commandTimeout, stallTimeout);
    this.maxTurns = maxTurns;

    this.defaultAllowedTools = [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'WebFetch',
      'WebSearch',
    ];
  }

  async chat(
    message: string,
    options: {
      sessionId?: string;
      cwd?: string;
      allowedTools?: string[];
      lockKey?: string;
      permissionMode?: string;
      model?: string;
      guildId?: string;
      channelId?: string;
      images?: import('../types/index.js').ImageAttachment[];
      sessionName?: string;
      worktreeBranch?: string;
    } = {},
    onProgress?: ProgressCallback
  ): Promise<ChatResult> {
    try {
      return await this.executeChat(message, options, onProgress);
    } catch (error: any) {
      if (!(error instanceof ClaudeExecutionError)) throw error;

      if (
        error.errorType === ClaudeErrorType.FATAL ||
        error.errorType === ClaudeErrorType.ABORTED ||
        error.errorType === ClaudeErrorType.PROCESS_KILLED ||
        error.errorType === ClaudeErrorType.AUTH_ERROR
      ) {
        throw error;
      }

      if (error.errorType === ClaudeErrorType.SESSION_RECOVERABLE) {
        logger.warn('Session recoverable error, resetting session:', error.message);
        // 通知 UI 层
        if (onProgress) {
          try { onProgress({ type: 'system', subtype: 'session_reset' } as any); } catch {}
          try { onProgress({ type: 'system', subtype: 'reset_state' } as any); } catch {}
        }
        // 清除 session，新建会话重试
        try {
          return await this.executeChat(message, { ...options, sessionId: undefined }, onProgress);
        } catch (retryError: any) {
          logger.error('Retry after session reset also failed:', retryError.message);
          throw error; // 抛出原始错误
        }
      }

      // RECOVERABLE: 重试一次（同参数）
      logger.warn('Recoverable error, retrying once:', error.message);
      if (onProgress) {
        try { onProgress({ type: 'system', subtype: 'retrying' } as any); } catch {}
        try { onProgress({ type: 'system', subtype: 'reset_state' } as any); } catch {}
      }
      try {
        return await this.executeChat(message, options, onProgress);
      } catch (retryError: any) {
        logger.error('Retry also failed:', retryError.message);
        throw error; // 抛出原始错误
      }
    }
  }

  private async executeChat(
    message: string,
    options: {
      sessionId?: string;
      cwd?: string;
      allowedTools?: string[];
      lockKey?: string;
      permissionMode?: string;
      model?: string;
      guildId?: string;
      channelId?: string;
      images?: import('../types/index.js').ImageAttachment[];
      sessionName?: string;
      worktreeBranch?: string;
    },
    onProgress?: ProgressCallback
  ): Promise<ChatResult> {
    // 构造 Discord 上下文 system prompt
    let appendSystemPrompt: string | undefined;
    if (options.channelId) {
      const lines = [
        `Discord Channel ID: ${options.channelId}`,
        `Session: ${options.sessionName || 'unknown'}`,
      ];
      if (options.worktreeBranch) lines.push(`Branch: ${options.worktreeBranch}`);
      appendSystemPrompt = lines.join('\n');
    }

    const claudeOptions: ClaudeOptions = {
      cwd: options.cwd,
      resume: options.sessionId,
      allowedTools: options.allowedTools || this.defaultAllowedTools,
      maxTurns: this.maxTurns,
      lockKey: options.lockKey,
      permissionMode: options.permissionMode,
      model: options.model,
      guildId: options.guildId,
      channelId: options.channelId,
      images: options.images,
      appendSystemPrompt,
    };

    logger.debug('Calling Claude with options:', claudeOptions);

    const response = await this.executor.execute(message, claudeOptions, onProgress);

    return {
      result: response.result,
      sessionId: response.session_id,
      usage: response.usage,
      duration_ms: response.duration_ms,
      total_cost_usd: response.total_cost_usd,
      contextWindow: response.contextWindow,
    };
  }

  async compact(
    sessionId: string,
    cwd?: string,
    lockKey?: string,
    onProgress?: ProgressCallback
  ): Promise<ChatResult> {
    const response = await this.executor.compact(sessionId, cwd, lockKey, onProgress);
    return {
      result: response.result,
      sessionId: response.session_id,
      usage: response.usage,
      duration_ms: response.duration_ms,
      total_cost_usd: response.total_cost_usd,
    };
  }

  abort(lockKey: string): boolean {
    return this.executor.abort(lockKey);
  }

  abortAll(): number {
    return this.executor.abortAll();
  }

  abortRunning(lockKey: string): { aborted: boolean; queueLength: number } {
    return this.executor.abortRunning(lockKey);
  }

  cancelQueued(lockKey: string): { cancelled: number; hasRunning: boolean } {
    return this.executor.cancelQueued(lockKey);
  }

  updateProgressInfo(lockKey: string, text: string, toolUseCount: number): void {
    this.executor.updateProgressInfo(lockKey, text, toolUseCount);
  }

  consumeInterruptContext(lockKey: string): { lastProgressText: string; toolUseCount: number } | null {
    return this.executor.consumeInterruptContext(lockKey);
  }

  getQueueLength(lockKey: string): number {
    return this.executor.getQueueLength(lockKey);
  }

  isRunning(lockKey: string): boolean {
    return this.executor.isRunning(lockKey);
  }

  detachAll(): void {
    this.executor.detachAll();
  }

  async reconnectAll(onResult: (info: ReconnectedResult) => Promise<void>): Promise<void> {
    return this.executor.reconnectAll(onResult);
  }

  async verify(): Promise<boolean> {
    return this.executor.verify();
  }

  setSessionSyncCallback(cb: (sessionId: string, channelId?: string, model?: string) => void): void {
    this.executor.onSessionSync = cb;
  }

  setSessionCloseCallback(cb: (sessionId: string) => void): void {
    this.executor.onSessionClose = cb;
  }
}
