/**
 * Claude Code CLI 命令执行器（stream-json 流式输出）
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { ClaudeResponse, ClaudeOptions, StreamEvent, ProgressCallback, ClaudeErrorType, ClaudeExecutionError } from '../types/index.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

interface LockEntry {
  running: boolean;
  queue: Array<{ resolve: (waited: boolean) => void; reject: (err: Error) => void }>;
}

interface ActiveProcess {
  child: ChildProcess;
  flags: { killed: boolean; aborted: boolean };
  timeoutHandle: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
}

export class ClaudeExecutor {
  private claudeCliPath: string;
  private commandTimeout: number;
  private locks: Map<string, LockEntry> = new Map();
  private activeProcesses: Map<string, ActiveProcess> = new Map();

  constructor(claudeCliPath: string = 'claude', commandTimeout: number = 300000) {
    this.claudeCliPath = claudeCliPath;
    this.commandTimeout = commandTimeout;
  }

  private getLock(key: string): LockEntry {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { running: false, queue: [] };
      this.locks.set(key, entry);
    }
    return entry;
  }

  /**
   * 获取锁，返回是否等待了（true = 排队等待过）
   */
  private async acquireLock(key: string): Promise<boolean> {
    const entry = this.getLock(key);
    if (!entry.running) {
      entry.running = true;
      return false;
    }

    logger.debug(`Waiting for lock [${key}] to release...`);
    return new Promise((resolve, reject) => {
      entry.queue.push({ resolve: () => resolve(true), reject });
    });
  }

  private releaseLock(key: string): void {
    const entry = this.locks.get(key);
    if (!entry) return;

    if (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      logger.debug(`Releasing lock [${key}], ${entry.queue.length} requests waiting`);
      next.resolve(true);
    } else {
      entry.running = false;
      // 空闲时清理 lock entry
      this.locks.delete(key);
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
    const lockKey = options.lockKey || '__global__';

    // 通知等待排队
    const queueLen = this.getLock(lockKey).queue.length;
    if (this.getLock(lockKey).running && onProgress) {
      onProgress({ type: 'system', subtype: 'queued', queue_position: queueLen + 1 } as any);
    }

    const waited = await this.acquireLock(lockKey);
    if (waited && onProgress) {
      onProgress({ type: 'system', subtype: 'lock_acquired' } as any);
    }

    try {
      const args = this.buildArgs(options);

      logger.debug('Spawning Claude CLI (stream):', {
        command: this.claudeCliPath,
        args: args.map(a => a.length > 50 ? `${a.slice(0, 50)}...` : a),
      });

      const child = spawn(this.claudeCliPath, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      logger.debug(`Process spawned: PID=${child.pid}`);

      const flags = { killed: false, aborted: false };
      this.activeProcesses.set(lockKey, { child, flags, timeoutHandle: null, killTimer: null });

      // 通过 stdin 写入 stream-json 格式的用户消息
      const input = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: 'default',
        parent_tool_use_id: null,
      });
      if (!child.stdin) {
        throw new ClaudeExecutionError('CLI stdin 不可用', ClaudeErrorType.FATAL);
      }
      child.stdin.write(input + '\n', 'utf8', () => child.stdin!.end());
      child.stdin.on('error', () => {}); // 进程提前退出时忽略 pipe 错误

      return await this.processStream(child, lockKey, flags, onProgress);
    } catch (error: any) {
      if (error instanceof ClaudeExecutionError) throw error;
      logger.error('Claude CLI execution failed:', error.message);
      throw new ClaudeExecutionError(`Claude CLI 执行失败: ${error.message}`, ClaudeErrorType.FATAL);
    } finally {
      this.activeProcesses.delete(lockKey);
      this.releaseLock(lockKey);
    }
  }

  /**
   * 向已有 session 发送 /compact 命令，触发上下文压缩
   */
  async compact(
    sessionId: string,
    cwd?: string,
    lockKey?: string,
    onProgress?: ProgressCallback
  ): Promise<ClaudeResponse> {
    const key = lockKey || '__global__';
    const waited = await this.acquireLock(key);
    if (waited && onProgress) {
      onProgress({ type: 'system', subtype: 'lock_acquired' } as any);
    }

    try {
      const args = this.buildArgs({ resume: sessionId, cwd });

      logger.debug('Spawning Claude CLI (compact):', { sessionId });

      const child = spawn(this.claudeCliPath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const flags = { killed: false, aborted: false };
      this.activeProcesses.set(key, { child, flags, timeoutHandle: null, killTimer: null });

      // 发送 /compact slash command
      const input = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/compact' },
        session_id: 'default',
        parent_tool_use_id: null,
      });
      if (!child.stdin) {
        throw new ClaudeExecutionError('CLI stdin 不可用', ClaudeErrorType.FATAL);
      }
      child.stdin.write(input + '\n', 'utf8', () => child.stdin!.end());
      child.stdin.on('error', () => {});

      return await this.processStream(child, key, flags, onProgress);
    } catch (error: any) {
      if (error instanceof ClaudeExecutionError) throw error;
      throw new ClaudeExecutionError(`Compact 失败: ${error.message}`, ClaudeErrorType.RECOVERABLE);
    } finally {
      this.activeProcesses.delete(key);
      this.releaseLock(key);
    }
  }

  /**
   * 逐行读取 stream-json，解析事件并回调
   */
  private processStream(
    child: ChildProcess,
    lockKey: string,
    flags: { killed: boolean; aborted: boolean },
    onProgress?: ProgressCallback
  ): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      let lineBuf = '';
      let resultEvent: StreamEvent | null = null;
      let lastSessionId = '';
      let compactPreTokens: number | null = null;
      const stderrChunks: Buffer[] = [];

      // 超时处理
      const active = this.activeProcesses.get(lockKey);
      if (this.commandTimeout > 0) {
        const timeoutHandle = setTimeout(() => {
          logger.warn(`Process timeout after ${this.commandTimeout}ms`);
          flags.killed = true;
          child.kill('SIGTERM');
          const killTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 5000);
          if (active) active.killTimer = killTimer;
        }, this.commandTimeout);
        if (active) active.timeoutHandle = timeoutHandle;
      }

      // 逐行解析 stdout（JSONL 格式）
      child.stdout!.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf8');

        let newlineIdx: number;
        while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, newlineIdx).trim();
          lineBuf = lineBuf.slice(newlineIdx + 1);

          if (!line) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(line) as StreamEvent;
          } catch (parseError: any) {
            logger.warn('Failed to parse stream event JSON:', parseError.message, 'Line:', line.slice(0, 100));
            continue;
          }

          try {
            if (event.session_id) {
              lastSessionId = event.session_id;
            }

            // 记录 compact 事件
            if (event.compact_metadata) {
              compactPreTokens = event.compact_metadata.pre_tokens;
              logger.info(`Compact triggered (${event.compact_metadata.trigger}): pre_tokens=${compactPreTokens}`);
            }

            // 回调进度
            if (onProgress) {
              try { onProgress(event); } catch (e) {
                logger.debug('Progress callback error:', e);
              }
            }

            // 记录最终结果
            if (event.type === 'result') {
              resultEvent = event;
              const compactInfo = compactPreTokens ? `, compact: ${compactPreTokens} → ${event.usage?.input_tokens}` : '';
              logger.debug(`Result: ${event.num_turns} turns, ${event.duration_ms}ms${compactInfo}`);
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
        if (active?.timeoutHandle) clearTimeout(active.timeoutHandle);
        if (active?.killTimer) clearTimeout(active.killTimer);

        // 处理 stdout 中残留的未换行数据
        if (lineBuf.trim()) {
          try {
            const event = JSON.parse(lineBuf.trim()) as StreamEvent;
            if (event.session_id) lastSessionId = event.session_id;
            if (onProgress) try { onProgress(event); } catch {}
            if (event.type === 'result') resultEvent = event;
          } catch (parseError: any) {
            logger.warn('Failed to parse trailing stream data:', parseError.message);
          }
          lineBuf = '';
        }

        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (flags.aborted) {
          reject(new ClaudeExecutionError(
            '任务已被用户停止',
            ClaudeErrorType.ABORTED
          ));
        } else if (flags.killed) {
          reject(new ClaudeExecutionError(
            `超时 (${this.commandTimeout / 1000}s)`,
            ClaudeErrorType.RECOVERABLE
          ));
        } else if (signal) {
          reject(new ClaudeExecutionError(
            `进程被信号终止: ${signal}`,
            ClaudeErrorType.RECOVERABLE
          ));
        } else if (resultEvent) {
          // 成功拿到 result 事件
          resolve({
            session_id: lastSessionId,
            result: resultEvent.result || '',
            usage: resultEvent.usage,
            duration_ms: resultEvent.duration_ms,
            total_cost_usd: resultEvent.total_cost_usd,
          });
        } else if (code !== 0) {
          const errorMsg = `退出码 ${code}\n${stderr}`;
          reject(new ClaudeExecutionError(errorMsg, this.classifyError(errorMsg)));
        } else {
          reject(new ClaudeExecutionError(
            '未收到 result 事件',
            ClaudeErrorType.RECOVERABLE
          ));
        }
      });

      child.on('error', (error) => {
        if (active?.timeoutHandle) clearTimeout(active.timeoutHandle);
        reject(new ClaudeExecutionError(
          `启动失败: ${error.message}`,
          this.classifyError(error.message)
        ));
      });
    });
  }

  private buildArgs(options: ClaudeOptions): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      // NOTE: intentional — Bot 运行在受信环境中，由 Telegram 鉴权 + allowedTools 白名单控制访问
      '--dangerously-skip-permissions',
    ];

    if (options.resume) {
      args.push('--resume', options.resume);
    }

    if (options.forkSession) {
      args.push('--fork-session');
    }

    if (options.permissionMode) {
      // permissionMode 覆盖默认的 dangerously-skip-permissions
      // 从 args 中移除 --dangerously-skip-permissions
      const skipIdx = args.indexOf('--dangerously-skip-permissions');
      if (skipIdx !== -1) args.splice(skipIdx, 1);
      args.push('--permission-mode', options.permissionMode);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    return args;
  }

  /**
   * 中止指定 lockKey 的运行中进程 + 排空等待队列
   */
  abort(lockKey: string): boolean {
    let aborted = false;

    // 1. 先排空队列（reject 所有等待中的请求），防止 releaseLock 时 dequeue
    const entry = this.locks.get(lockKey);
    if (entry && entry.queue.length > 0) {
      const err = new ClaudeExecutionError('任务已被用户停止', ClaudeErrorType.ABORTED);
      for (const q of entry.queue) q.reject(err);
      entry.queue = [];
      aborted = true;
    }

    // 2. 再杀运行中的进程
    const active = this.activeProcesses.get(lockKey);
    if (active) {
      active.flags.aborted = true;
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
      active.child.kill('SIGTERM');
      active.killTimer = setTimeout(() => {
        if (active.child.exitCode === null) active.child.kill('SIGKILL');
      }, 3000);
      aborted = true;
    }

    return aborted;
  }

  /**
   * 查询指定 lockKey 是否有正在运行的进程
   */
  isRunning(lockKey: string): boolean {
    return this.activeProcesses.has(lockKey);
  }

  /**
   * 根据错误消息内容分类错误类型
   */
  private classifyError(message: string): ClaudeErrorType {
    const lower = message.toLowerCase();

    // 上下文溢出 → 清除 session 重试
    if (lower.includes('prompt is too long') || lower.includes('context_length_exceeded')) {
      return ClaudeErrorType.SESSION_RECOVERABLE;
    }

    // CLI 不可用 → 不重试
    if (lower.includes('enoent') || lower.includes('not authenticated') || lower.includes('spawn')) {
      return ClaudeErrorType.FATAL;
    }

    // 默认：可恢复（超时/崩溃等）
    return ClaudeErrorType.RECOVERABLE;
  }

  async verify(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(this.claudeCliPath, ['--version'], {
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
