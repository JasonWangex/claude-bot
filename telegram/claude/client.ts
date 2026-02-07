/**
 * Claude Code 客户端 - 高级接口
 */

import { ClaudeExecutor } from './executor.js';
import { ClaudeOptions, ProgressCallback } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class ClaudeClient {
  private executor: ClaudeExecutor;
  private defaultAllowedTools: string[];
  private maxTurns: number;

  constructor(
    claudeCliPath: string = 'claude',
    commandTimeout: number = 300000,
    maxTurns: number = 20
  ) {
    this.executor = new ClaudeExecutor(claudeCliPath, commandTimeout);
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
    } = {},
    onProgress?: ProgressCallback
  ): Promise<{ result: string; sessionId: string }> {
    const claudeOptions: ClaudeOptions = {
      cwd: options.cwd,
      resume: options.sessionId,
      allowedTools: options.allowedTools || this.defaultAllowedTools,
      maxTurns: this.maxTurns,
    };

    logger.debug('Calling Claude with options:', claudeOptions);

    const response = await this.executor.execute(message, claudeOptions, onProgress);

    return {
      result: response.result,
      sessionId: response.session_id,
    };
  }

  async verify(): Promise<boolean> {
    return this.executor.verify();
  }
}
