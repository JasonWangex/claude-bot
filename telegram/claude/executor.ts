/**
 * Claude Code CLI 命令执行器（stream-json 流式输出）
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { ClaudeResponse, ClaudeOptions, StreamEvent, ProgressCallback } from '../types/index.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

export class ClaudeExecutor {
  private claudeCliPath: string;
  private commandTimeout: number;
  private isExecuting: boolean = false;
  private executionQueue: Array<() => void> = [];

  constructor(claudeCliPath: string = 'claude', commandTimeout: number = 300000) {
    this.claudeCliPath = claudeCliPath;
    this.commandTimeout = commandTimeout;
  }

  private async acquireLock(): Promise<void> {
    if (!this.isExecuting) {
      this.isExecuting = true;
      return;
    }

    logger.debug('Waiting for previous execution to complete...');
    return new Promise((resolve) => {
      this.executionQueue.push(resolve);
    });
  }

  private releaseLock(): void {
    if (this.executionQueue.length > 0) {
      const next = this.executionQueue.shift()!;
      logger.debug(`Releasing lock, ${this.executionQueue.length} requests waiting`);
      next();
    } else {
      this.isExecuting = false;
    }
  }

  /**
   * 流式执行 Claude CLI，逐行解析 stream-json 事件
   */
  async execute(
    prompt: string,
    options: ClaudeOptions = {},
    onProgress?: ProgressCallback
  ): Promise<ClaudeResponse> {
    await this.acquireLock();

    try {
      const args = this.buildArgs(prompt, options);

      logger.debug('Spawning Claude CLI (stream):', {
        command: this.claudeCliPath,
        args: args.map(a => a.length > 50 ? `${a.slice(0, 50)}...` : a),
      });

      const child = spawn(this.claudeCliPath, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      logger.debug(`Process spawned: PID=${child.pid}`);

      return await this.processStream(child, onProgress);
    } catch (error: any) {
      logger.error('Claude CLI execution failed:', error.message);
      throw new Error(`Claude CLI 执行失败: ${error.message}`);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * 逐行读取 stream-json，解析事件并回调
   */
  private processStream(
    child: ChildProcess,
    onProgress?: ProgressCallback
  ): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let killed = false;
      let lineBuf = '';
      let resultEvent: StreamEvent | null = null;
      let lastSessionId = '';
      const stderrChunks: Buffer[] = [];

      // 超时处理
      if (this.commandTimeout > 0) {
        timeoutHandle = setTimeout(() => {
          logger.warn(`Process timeout after ${this.commandTimeout}ms`);
          killed = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 5000);
        }, this.commandTimeout);
      }

      // 逐行解析 stdout（JSONL 格式）
      child.stdout!.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf8');

        let newlineIdx: number;
        while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, newlineIdx).trim();
          lineBuf = lineBuf.slice(newlineIdx + 1);

          if (!line) continue;

          try {
            const event = JSON.parse(line) as StreamEvent;

            if (event.session_id) {
              lastSessionId = event.session_id;
            }

            // 回调进度
            if (onProgress) {
              try { onProgress(event); } catch {}
            }

            // 记录最终结果
            if (event.type === 'result') {
              resultEvent = event;
              logger.debug(`Result: ${event.num_turns} turns, ${event.duration_ms}ms`);
            }
          } catch {
            logger.debug('Non-JSON stdout line:', line.slice(0, 100));
          }
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on('exit', (code, signal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (killed) {
          reject(new Error(`超时 (${this.commandTimeout / 1000}s)`));
        } else if (signal) {
          reject(new Error(`进程被信号终止: ${signal}`));
        } else if (resultEvent) {
          // 成功拿到 result 事件
          resolve({
            session_id: lastSessionId,
            result: resultEvent.result || '',
            usage: resultEvent.usage,
          });
        } else if (code !== 0) {
          reject(new Error(`退出码 ${code}\n${stderr}`));
        } else {
          reject(new Error('未收到 result 事件'));
        }
      });

      child.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(new Error(`启动失败: ${error.message}`));
      });
    });
  }

  private buildArgs(prompt: string, options: ClaudeOptions): string[] {
    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (options.resume) {
      args.push('--resume', options.resume);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    return args;
  }

  async verify(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`${this.claudeCliPath} --version`, {
        timeout: 5000,
      });
      logger.info('Claude CLI version:', stdout.trim());
      return true;
    } catch (error) {
      logger.error('Claude CLI not available:', error);
      return false;
    }
  }
}
