/**
 * Claude Code CLI 命令执行器（stream-json 流式输出）
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { openSync, closeSync, readSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, renameSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { ClaudeResponse, ClaudeOptions, StreamEvent, ProgressCallback, ClaudeErrorType, ClaudeExecutionError, ProcessRegistryEntry, ReconnectedResult } from '../types/index.js';
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
  outputFile?: string;
  stderrFile?: string;
  guildId?: string;
  channelId?: string;
  claudeSessionId?: string;
  cwd?: string;
  lastProgressText?: string;
  toolUseCount?: number;
  stdin?: import('stream').Writable;  // kept open until done signal (result or Stop hook)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ClaudeExecutor {
  private claudeCliPath: string;
  private commandTimeout: number;
  private stallTimeout: number;
  private locks: Map<string, LockEntry> = new Map();
  private activeProcesses: Map<string, ActiveProcess> = new Map();
  private interruptContext: Map<string, { lastProgressText: string; toolUseCount: number }> = new Map();
  private processDir: string;
  private registryFile: string;

  // Session sync callback (injected by bot)
  onSessionSync?: (sessionId: string, channelId?: string, model?: string) => void;

  // Session close callback (injected by bot) - called when session is interrupted/killed
  onSessionClose?: (sessionId: string) => void;

  constructor(claudeCliPath: string = 'claude', commandTimeout: number = 300000, stallTimeout: number = 60000) {
    this.claudeCliPath = claudeCliPath;
    this.commandTimeout = commandTimeout;
    this.stallTimeout = stallTimeout;
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.processDir = join(thisDir, '../../data/processes');
    this.registryFile = join(thisDir, '../../data/active-processes.json');
    mkdirSync(this.processDir, { recursive: true });
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

    // 排队等待后重新解析 session ID：前一个任务已完成并更新了 claudeSessionId，
    // 此时用最新值覆盖，避免排队消息用旧的（可能是 undefined）session ID 创建新会话。
    const execOptions = (waited && options.resolveSessionId)
      ? { ...options, resume: options.resolveSessionId() ?? options.resume }
      : options;

    try {
      const args = this.buildArgs(execOptions);

      logger.debug('Spawning Claude CLI (stream):', {
        command: this.claudeCliPath,
        args: args.map(a => a.length > 50 ? `${a.slice(0, 50)}...` : a),
      });

      const outputFile = join(this.processDir, `${Date.now()}-${lockKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
      const stderrFile = outputFile.replace('.jsonl', '.stderr');
      let outputFd: number | null = null;
      let stderrFd: number | null = null;
      try {
        outputFd = openSync(outputFile, 'w');
        stderrFd = openSync(stderrFile, 'w');
      } catch (e: any) {
        if (outputFd !== null) closeSync(outputFd);
        throw new ClaudeExecutionError(`无法创建输出文件: ${e.message}`, ClaudeErrorType.FATAL);
      }

      const child = spawn(this.claudeCliPath, args, {
        cwd: options.cwd,
        stdio: ['pipe', outputFd, stderrFd],
        detached: true,
      });

      // 父进程关闭自己的 fd 副本（子进程仍持有自己的副本）
      closeSync(outputFd);
      closeSync(stderrFd);

      logger.debug(`Process spawned: PID=${child.pid}, outputFile=${outputFile}`);

      const flags = { killed: false, aborted: false, stalled: false };
      this.activeProcesses.set(lockKey, {
        child, flags, timeoutHandle: null, killTimer: null,
        outputFile, stderrFile,
        guildId: options.guildId, channelId: options.channelId,
        cwd: options.cwd,
        stdin: child.stdin ?? undefined,
      });

      // 通过 stdin 写入 stream-json 格式的用户消息
      // 有图片时使用 content block 数组（Messages API 格式），无图片时保持字符串
      let content: string | Array<Record<string, unknown>> = prompt;
      if (options.images?.length) {
        content = [
          ...options.images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          })),
          { type: 'text', text: prompt },
        ];
      }
      const input = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        session_id: 'default',
        parent_tool_use_id: null,
      });
      if (!child.stdin) {
        throw new ClaudeExecutionError('CLI stdin 不可用', ClaudeErrorType.FATAL);
      }
      // stdin 保持开放，直到 result 事件或 Stop hook 触发关闭
      child.stdin.write(input + '\n', 'utf8');
      child.stdin.on('error', () => {}); // 进程提前退出时忽略 pipe 错误

      return await this.tailOutputFile(outputFile, stderrFile, child, lockKey, flags, onProgress);
    } catch (error: any) {
      if (error instanceof ClaudeExecutionError) throw error;
      logger.error('Claude CLI execution failed:', error);
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

      const outputFile = join(this.processDir, `${Date.now()}-compact-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
      const stderrFile = outputFile.replace('.jsonl', '.stderr');
      let outputFd: number | null = null;
      let stderrFd: number | null = null;
      try {
        outputFd = openSync(outputFile, 'w');
        stderrFd = openSync(stderrFile, 'w');
      } catch (e: any) {
        if (outputFd !== null) closeSync(outputFd);
        throw new ClaudeExecutionError(`无法创建输出文件: ${e.message}`, ClaudeErrorType.FATAL);
      }

      const child = spawn(this.claudeCliPath, args, {
        cwd,
        stdio: ['pipe', outputFd, stderrFd],
        detached: true,
      });

      closeSync(outputFd);
      closeSync(stderrFd);

      const flags = { killed: false, aborted: false, stalled: false };
      this.activeProcesses.set(key, { child, flags, timeoutHandle: null, killTimer: null, outputFile, stderrFile });

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

      return await this.tailOutputFile(outputFile, stderrFile, child, key, flags, onProgress);
    } catch (error: any) {
      if (error instanceof ClaudeExecutionError) throw error;
      throw new ClaudeExecutionError(`Compact 失败: ${error.message}`, ClaudeErrorType.RECOVERABLE);
    } finally {
      this.activeProcesses.delete(key);
      this.releaseLock(key);
    }
  }

  /**
   * 通过轮询文件获取 JSONL 事件流（替代 pipe 监听）
   */
  private tailOutputFile(
    outputFile: string,
    stderrFile: string,
    child: ChildProcess,
    lockKey: string,
    flags: { killed: boolean; aborted: boolean; stalled: boolean },
    onProgress?: ProgressCallback
  ): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      let offset = 0;
      let lineBuf = '';
      let resultEvent: StreamEvent | null = null;
      let lastSessionId = '';
      let compactPreTokens: number | null = null;
      let lastOutputTime = Date.now();
      let stallWarned = false;
      let compacting = false;   // 自动压缩中，暂停 stall 检测和 command timeout

      const readNewData = () => {
        try {
          let fileSize: number;
          try {
            fileSize = statSync(outputFile).size;
          } catch {
            return; // 文件不存在（已清理）
          }
          if (fileSize <= offset) return;

          const buf = Buffer.alloc(fileSize - offset);
          const fd = openSync(outputFile, 'r');
          try {
            readSync(fd, buf, 0, buf.length, offset);
          } finally {
            closeSync(fd);
          }
          offset = fileSize;
          lastOutputTime = Date.now();
          // 输出恢复，重置 stall 警告状态（下次 stall 可再次警告）
          stallWarned = false;

          lineBuf += buf.toString('utf8');

          let newlineIdx: number;
          while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, newlineIdx).trim();
            lineBuf = lineBuf.slice(newlineIdx + 1);
            if (!line) continue;

            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              logger.warn('JSONL parse failed, skipping line:', line.slice(0, 200));
              continue;
            }

            if (event.session_id) {
              lastSessionId = event.session_id;
              // 首次收到 session_id 时立即同步（而非等待进程结束）
              if (lastSessionId !== active?.claudeSessionId) {
                updateSessionId();
                // 立即调用 onSessionSync 记录 session 创建
                if (this.onSessionSync) {
                  try {
                    this.onSessionSync(lastSessionId, active?.channelId, undefined);
                  } catch (e: any) {
                    logger.warn(`Session sync failed: ${e.message}`);
                  }
                }
              }
            }

            // 追踪压缩状态：压缩期间暂停 stall 检测和 command timeout
            // status 事件格式: {type:"system", subtype:"status", status:"compacting"|null}
            if (event.type === 'system' && event.subtype === 'status') {
              if (event.status === 'compacting' && !compacting) {
                compacting = true;
                // 暂停 command timeout：压缩期间不应计入超时
                if (active?.timeoutHandle) {
                  clearTimeout(active.timeoutHandle);
                  active.timeoutHandle = null;
                  logger.debug('Command timeout paused during compaction');
                }
              } else if (event.status !== 'compacting' && compacting) {
                compacting = false;
                this.resetCommandTimeout(child, flags, active);
              }
            } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
              // compact_boundary 是压缩结束的确定信号
              if (compacting) {
                compacting = false;
                this.resetCommandTimeout(child, flags, active);
              }
            } else if (event.type === 'assistant' && compacting) {
              // fallback: compacting 状态下收到 assistant 事件，说明压缩已结束
              compacting = false;
              this.resetCommandTimeout(child, flags, active);
            }

            if (event.compact_metadata) {
              compactPreTokens = event.compact_metadata.pre_tokens;
              logger.info(`Compact triggered (${event.compact_metadata.trigger}): pre_tokens=${compactPreTokens}`);
            }

            if (onProgress) {
              try { onProgress(event); } catch (e) {
                logger.warn('Progress callback error:', e);
              }
            }

            if (event.type === 'result') {
              resultEvent = event;
              const postTokens = event.usage ? event.usage.input_tokens + (event.usage.cache_read_input_tokens || 0) + (event.usage.cache_creation_input_tokens || 0) : '?';
              const compactInfo = compactPreTokens ? `, compact: ${compactPreTokens} → ${postTokens}` : '';
              logger.debug(`Result: ${event.num_turns} turns, ${event.duration_ms}ms${compactInfo}`);

              // result 事件 = done 信号之一：尝试关闭 stdin
              // 与 Stop hook 的 tryCloseStdinForSession 逻辑相同，两者都幂等
              if (active?.stdin && !flags.killed && !flags.aborted && !active.stdin.writableEnded) {
                setImmediate(() => {
                  if (!active.stdin?.writableEnded) {
                    logger.debug(`[${lockKey}] result event: closing stdin`);
                    try { active.stdin?.end(); } catch {}
                  }
                });
              }
            }
          }
        } catch (e) {
          logger.warn('tailOutputFile readNewData error:', e);
        }
      };

      // 每 300ms 轮询一次文件
      const pollTimer = setInterval(readNewData, 300);

      const active = this.activeProcesses.get(lockKey);

      // Stall detection: 连续 stallTimeout 毫秒无输出时发送警告（不杀进程）
      // 用户可通过 /stop 手动终止；command timeout 作为硬性兜底
      const stallTimer = this.stallTimeout > 0 ? setInterval(() => {
        if (flags.killed || flags.aborted || compacting) return;
        const elapsed = Date.now() - lastOutputTime;
        if (elapsed > this.stallTimeout && !stallWarned) {
          stallWarned = true;
          logger.warn(`Process stalled: no output for ${this.stallTimeout / 1000}s (warning only, not killing)`);
          if (onProgress) {
            try {
              onProgress({ type: 'system', subtype: 'stall_warning', stallSeconds: Math.round(elapsed / 1000) } as any);
            } catch {}
          }
        }
      }, 10000) : null;

      // 超时处理
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

      // 更新 active process 的 claudeSessionId（用于 detachAll 保存）
      const updateSessionId = () => {
        if (lastSessionId && active) {
          active.claudeSessionId = lastSessionId;
        }
      };

      child.on('exit', (code, signal) => {
        clearInterval(pollTimer);
        if (stallTimer) clearInterval(stallTimer);
        if (active?.timeoutHandle) clearTimeout(active.timeoutHandle);
        if (active?.killTimer) clearTimeout(active.killTimer);
        // 进程已退出，确保 stdin 资源释放
        if (active?.stdin) { try { active.stdin.destroy(); } catch {} }

        // 读取最终数据
        readNewData();

        // 处理 lineBuf 中残留的未换行数据
        if (lineBuf.trim()) {
          try {
            const event = JSON.parse(lineBuf.trim()) as StreamEvent;
            if (event.session_id) lastSessionId = event.session_id;
            if (onProgress) try { onProgress(event); } catch {}
            if (event.type === 'result') resultEvent = event;
          } catch {
            logger.warn('JSONL parse failed for trailing buffer:', lineBuf.trim().slice(0, 200));
          }
          lineBuf = '';
        }

        updateSessionId();

        // 读取 stderr（在归档文件前）
        let stderr = '';
        try { stderr = readFileSync(stderrFile, 'utf-8'); } catch {}

        // 归档输出文件到 data/sessions/<session_id>/ 目录
        this.archiveOutputFiles(outputFile, stderrFile, lastSessionId);

        // 同步到 claude_sessions 表
        if (lastSessionId && this.onSessionSync) {
          const model = resultEvent?.modelUsage
            ? Object.keys(resultEvent.modelUsage)[0]
            : undefined;
          try {
            this.onSessionSync(lastSessionId, active?.channelId, model);
          } catch (e: any) {
            logger.warn(`Session sync failed: ${e.message}`);
          }
        }

        if (flags.aborted) {
          // 进程被用户终止，调用 onSessionClose 回调
          if (lastSessionId && this.onSessionClose) {
            try {
              this.onSessionClose(lastSessionId);
            } catch (e: any) {
              logger.warn(`Session close callback failed: ${e.message}`);
            }
          }
          // 把 sessionId 附在错误上，供上层在 abort 后保留 session 以便下次 resume。
          // 若进程极早退出（未输出 session_id 事件），回退到 active 中保存的 claudeSessionId。
          const abortedSessionId = lastSessionId || active?.claudeSessionId;
          reject(new ClaudeExecutionError(
            '任务已被用户停止',
            ClaudeErrorType.ABORTED,
            abortedSessionId || undefined,
          ));
        } else if (flags.killed) {
          // 进程超时被杀，调用 onSessionClose 回调
          if (lastSessionId && this.onSessionClose) {
            try {
              this.onSessionClose(lastSessionId);
            } catch (e: any) {
              logger.warn(`Session close callback failed: ${e.message}`);
            }
          }
          const reason = `超时 (${this.commandTimeout / 1000}s)`;
          reject(new ClaudeExecutionError(reason, ClaudeErrorType.PROCESS_KILLED));
        } else if (signal) {
          // 进程被信号终止，调用 onSessionClose 回调
          if (lastSessionId && this.onSessionClose) {
            try {
              this.onSessionClose(lastSessionId);
            } catch (e: any) {
              logger.warn(`Session close callback failed: ${e.message}`);
            }
          }
          reject(new ClaudeExecutionError(
            `进程被信号终止: ${signal}`,
            ClaudeErrorType.PROCESS_KILLED
          ));
        } else if (resultEvent) {
          // 检查 result 内容是否本身是错误（如 403 认证失败会以 result 事件返回）
          // is_error=true 时优先从 errors[] 取错误文本（result 字段可能为空）
          const resultText = resultEvent.is_error
            ? (resultEvent.errors?.[0] || resultEvent.result || 'Unknown error')
            : (resultEvent.result || '');
          const resultErrorType = this.classifyError(resultText);
          if (resultErrorType !== ClaudeErrorType.RECOVERABLE) {
            reject(new ClaudeExecutionError(resultText, resultErrorType));
          } else if (resultEvent.is_error && (resultEvent.errors?.length || !resultEvent.result?.trim())) {
            // is_error=true 且 errors[] 有内容（CLI 明确报错），或 result 为空（无有效响应）
            // → 清 session 重试，避免存入无效 session ID
            // 注意：若 errors[] 为空且 result 有内容，说明 is_error 可能是 CLI 误标记，
            // 此时应 resolve 而非 reject，否则实际响应内容会以错误格式发送，导致重复消息。
            reject(new ClaudeExecutionError(resultText, ClaudeErrorType.SESSION_RECOVERABLE));
          } else {
            // 从 modelUsage 中提取 contextWindow
            let contextWindow: number | undefined;
            if (resultEvent.modelUsage) {
              const firstModel = Object.values(resultEvent.modelUsage)[0];
              if (firstModel) contextWindow = firstModel.contextWindow;
            }
            resolve({
              session_id: lastSessionId,
              result: resultText,
              usage: resultEvent.usage,
              duration_ms: resultEvent.duration_ms,
              total_cost_usd: resultEvent.total_cost_usd,
              contextWindow,
            });
          }
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
        clearInterval(pollTimer);
        if (stallTimer) clearInterval(stallTimer);
        if (active?.timeoutHandle) clearTimeout(active.timeoutHandle);
        if (active?.killTimer) clearTimeout(active.killTimer);
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
      // NOTE: intentional — Bot 运行在受信环境中，由 Discord Guild 鉴权 + allowedTools 白名单控制访问
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

    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }

    return args;
  }

  /**
   * 解析 lockKey 前缀，返回所有匹配的完整 key
   */
  private resolveKeys(lockKeyOrPrefix: string): string[] {
    // 尝试精确匹配
    if (this.locks.has(lockKeyOrPrefix) || this.activeProcesses.has(lockKeyOrPrefix)) {
      return [lockKeyOrPrefix];
    }

    // 前缀匹配
    const matched: string[] = [];
    for (const key of this.locks.keys()) {
      if (key.startsWith(lockKeyOrPrefix)) {
        matched.push(key);
      }
    }
    for (const key of this.activeProcesses.keys()) {
      if (key.startsWith(lockKeyOrPrefix) && !matched.includes(key)) {
        matched.push(key);
      }
    }
    return matched;
  }

  /**
   * 中止指定 lockKey 的运行中进程 + 排空等待队列
   * 优先精确匹配，回退到前缀匹配
   */
  abort(lockKeyOrPrefix: string): boolean {
    let aborted = false;
    const matchedKeys = this.resolveKeys(lockKeyOrPrefix);

    for (const lockKey of matchedKeys) {
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
        if (active.stdin) { try { active.stdin.destroy(); } catch {} }
        active.child.kill('SIGTERM');
        active.killTimer = setTimeout(() => {
          if (active.child.exitCode === null) active.child.kill('SIGKILL');
        }, 3000);
        aborted = true;
      }
    }

    return aborted;
  }

  /**
   * 只杀运行中的进程，不排空队列
   * 队列中的消息会在进程退出后自然获得锁并继续执行
   */
  abortRunning(lockKeyOrPrefix: string): { aborted: boolean; queueLength: number } {
    const matchedKeys = this.resolveKeys(lockKeyOrPrefix);
    let aborted = false;
    let queueLength = 0;

    for (const lockKey of matchedKeys) {
      const entry = this.locks.get(lockKey);
      if (entry) queueLength += entry.queue.length;

      const active = this.activeProcesses.get(lockKey);
      if (active) {
        // 保存中断上下文
        if (active.lastProgressText) {
          this.interruptContext.set(lockKey, {
            lastProgressText: active.lastProgressText,
            toolUseCount: active.toolUseCount || 0,
          });
          // 30 秒后自动清理防止内存泄漏
          setTimeout(() => this.interruptContext.delete(lockKey), 30000);
        }

        active.flags.aborted = true;
        if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
        if (active.stdin) { try { active.stdin.destroy(); } catch {} }
        active.child.kill('SIGTERM');
        active.killTimer = setTimeout(() => {
          if (active.child.exitCode === null) active.child.kill('SIGKILL');
        }, 3000);
        aborted = true;
      }
    }

    return { aborted, queueLength };
  }

  /**
   * 向正在运行的 Claude 进程注入新消息（写入 stdin）
   * 无需排队，Claude 处理完当前消息后立即读取下一条
   * writableEnded=true 时注入失败，由调用方走新会话流程
   */
  injectMessage(lockKey: string, content: string | Array<Record<string, unknown>>): boolean {
    const active = this.activeProcesses.get(lockKey);
    if (!active?.stdin || active.flags.killed || active.flags.aborted) return false;
    // stdin.end() 已调用时，writableEnded=true，写入无效
    if (active.stdin.writableEnded) return false;

    const input = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      session_id: 'default',
      parent_tool_use_id: null,
    });

    try {
      active.stdin.write(input + '\n', 'utf8');
      logger.debug(`[${lockKey}] Message injected`);
      return true;
    } catch (e: any) {
      logger.warn(`[${lockKey}] injectMessage failed: ${e.message}`);
      return false;
    }
  }

  /**
   * 更新活跃进程的进度信息（供 handler 回写）
   */
  updateProgressInfo(lockKey: string, text: string, toolUseCount: number): void {
    const active = this.activeProcesses.get(lockKey);
    if (active) {
      active.lastProgressText = text;
      active.toolUseCount = toolUseCount;
    }
  }

  /**
   * done 信号触发（result 事件或 Stop hook）：关闭 stdin
   * stdin.end() 是幂等的：若已有注入消息在 buffer 中，Claude 会读完再 EOF；
   * 若注入发生在 end() 之后，injectMessage 会检测到 writableEnded 并返回 false，
   * 由调用方走新 session 流程。
   *
   * setImmediate：给同一 I/O 批次中可能到来的 injectMessage() 先写入 buffer 的机会
   */
  tryCloseStdinForSession(claudeSessionId: string): void {
    for (const [lockKey, active] of this.activeProcesses) {
      if (active.claudeSessionId !== claudeSessionId) continue;
      if (!active.stdin || active.flags.killed || active.flags.aborted) return;
      if (active.stdin.writableEnded) return;

      setImmediate(() => {
        if (!active.stdin?.writableEnded) {
          logger.debug(`[${lockKey}] done signal: closing stdin`);
          try { active.stdin?.end(); } catch {}
        }
      });
      return;
    }
    logger.debug(`[tryCloseStdinForSession] No active process for session ${claudeSessionId?.slice(0, 8)}`);
  }

  /**
   * 消费中断上下文（一次性读取后删除）
   */
  consumeInterruptContext(lockKey: string): { lastProgressText: string; toolUseCount: number } | null {
    const ctx = this.interruptContext.get(lockKey);
    if (ctx) {
      this.interruptContext.delete(lockKey);
      return ctx;
    }
    return null;
  }

  /**
   * 取消排队中的请求（只排空队列，不杀运行中的进程）
   * 如果有正在运行的任务，返回 hasRunning=true，提示用户改用 stop
   */
  cancelQueued(lockKeyOrPrefix: string): { cancelled: number; hasRunning: boolean } {
    const matchedKeys = this.resolveKeys(lockKeyOrPrefix);
    let cancelled = 0;
    let hasRunning = false;

    for (const lockKey of matchedKeys) {
      const entry = this.locks.get(lockKey);
      if (entry && entry.queue.length > 0) {
        const err = new ClaudeExecutionError('任务已被用户取消', ClaudeErrorType.ABORTED);
        for (const q of entry.queue) q.reject(err);
        cancelled += entry.queue.length;
        entry.queue = [];
      }

      if (this.activeProcesses.has(lockKey)) {
        hasRunning = true;
      }
    }

    return { cancelled, hasRunning };
  }

  /**
   * 查询指定 lockKey 的队列长度
   */
  getQueueLength(lockKeyOrPrefix: string): number {
    const matchedKeys = this.resolveKeys(lockKeyOrPrefix);
    let total = 0;
    for (const key of matchedKeys) {
      const entry = this.locks.get(key);
      if (entry) total += entry.queue.length;
    }
    return total;
  }

  /**
   * 查询指定 lockKey 是否有正在运行的进程
   */
  isRunning(lockKey: string): boolean {
    return this.activeProcesses.has(lockKey);
  }

  /**
   * 压缩结束后重新启动 command timeout
   */
  private resetCommandTimeout(
    child: ChildProcess,
    flags: { killed: boolean; aborted: boolean },
    active: ActiveProcess | undefined
  ): void {
    if (this.commandTimeout <= 0 || flags.killed || flags.aborted) return;
    // 清除旧的（如果有的话）
    if (active?.timeoutHandle) {
      clearTimeout(active.timeoutHandle);
      active.timeoutHandle = null;
    }
    const timeoutHandle = setTimeout(() => {
      logger.warn(`Process timeout after ${this.commandTimeout}ms (post-compact)`);
      flags.killed = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
      if (active) active.killTimer = killTimer;
    }, this.commandTimeout);
    if (active) active.timeoutHandle = timeoutHandle;
    logger.debug('Command timeout restarted after compaction');
  }

  /**
   * 根据错误消息内容分类错误类型
   */
  private classifyError(message: string): ClaudeErrorType {
    const lower = message.toLowerCase();

    // 上下文溢出 / resume 目标 session 不存在 → 清除 session 重试
    if (
      lower.includes('prompt is too long') ||
      lower.includes('context_length_exceeded') ||
      lower.includes('no conversation found')
    ) {
      return ClaudeErrorType.SESSION_RECOVERABLE;
    }

    // 403 认证错误 → 由上层拦截器处理自动重试
    if (
      lower.includes('failed to authenticate') ||
      (lower.includes('403') && (lower.includes('forbidden') || lower.includes('request not allowed')))
    ) {
      return ClaudeErrorType.AUTH_ERROR;
    }

    // 500 服务端错误 → 由上层拦截器处理退避重试
    if (
      lower.includes('"api_error"') ||
      lower.includes('internal server error') ||
      (lower.includes('api error') && lower.includes('500'))
    ) {
      return ClaudeErrorType.API_ERROR;
    }

    // CLI 不可用 → 不重试
    if (lower.includes('enoent') || lower.includes('not authenticated') || lower.includes('spawn')) {
      return ClaudeErrorType.FATAL;
    }

    // 默认：可恢复（超时/崩溃等）
    return ClaudeErrorType.RECOVERABLE;
  }

  /**
   * 中止所有活跃进程（紧急模式用）
   */
  abortAll(): number {
    let count = 0;
    const lockKeys = [...this.activeProcesses.keys()];
    for (const lockKey of lockKeys) {
      if (this.abort(lockKey)) count++;
    }
    return count;
  }

  /**
   * 优雅关闭：解除所有子进程的关联，让它们继续运行
   * 在 Bot 收到 SIGTERM 时调用，确保 Claude CLI 不会被一起杀掉
   */
  detachAll(): void {
    const registry: ProcessRegistryEntry[] = [];

    for (const [lockKey, active] of this.activeProcesses.entries()) {
      logger.info(`Detaching process: PID=${active.child.pid}, lockKey=${lockKey}`);

      // 清除超时定时器
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
      if (active.killTimer) clearTimeout(active.killTimer);

      // 移除所有事件监听器，让 Node.js 可以正常退出
      active.child.removeAllListeners();

      // unref 让 Node.js 事件循环不再等待此子进程
      active.child.unref();

      // 收集注册信息
      if (active.child.pid && active.outputFile) {
        registry.push({
          pid: active.child.pid,
          outputFile: active.outputFile,
          stderrFile: active.stderrFile || '',
          guildId: active.guildId || '',
          channelId: active.channelId || '',
          lockKey,
          claudeSessionId: active.claudeSessionId,
          cwd: active.cwd,
          startTime: Date.now(),
        });
      }
    }

    // 保存到磁盘
    if (registry.length > 0) {
      try {
        writeFileSync(this.registryFile, JSON.stringify(registry, null, 2));
        logger.info(`Saved ${registry.length} process(es) to registry for reconnection`);
      } catch (e: any) {
        logger.error('Failed to save process registry:', e);
      }
    }

    const count = this.activeProcesses.size;
    this.activeProcesses.clear();

    // 清空所有锁队列
    for (const [, entry] of this.locks.entries()) {
      for (const q of entry.queue) {
        q.reject(new ClaudeExecutionError('Bot 正在重启', ClaudeErrorType.RECOVERABLE));
      }
      entry.queue = [];
    }
    this.locks.clear();

    if (count > 0) {
      logger.info(`Detached ${count} running Claude process(es), they will continue independently`);
    }
  }

  /**
   * 重连上次 Bot 关闭时仍在运行的 Claude 进程
   */
  async reconnectAll(
    onResult: (info: ReconnectedResult) => Promise<void>
  ): Promise<void> {
    let registry: ProcessRegistryEntry[];
    try {
      registry = JSON.parse(readFileSync(this.registryFile, 'utf-8'));
    } catch {
      return; // 无注册表或解析失败
    }

    // 清除注册表文件
    try { unlinkSync(this.registryFile); } catch {}

    logger.info(`Reconnecting ${registry.length} orphaned process(es)...`);

    for (const entry of registry) {
      const alive = isProcessAlive(entry.pid);
      const parseResult = this.parseOutputFile(entry.outputFile);

      if (parseResult.resultEvent) {
        // 进程已完成，发送结果
        logger.info(`Orphaned process PID=${entry.pid} already completed`);
        await onResult({
          guildId: entry.guildId,
          channelId: entry.channelId,
          lockKey: entry.lockKey,
          claudeSessionId: parseResult.sessionId || entry.claudeSessionId,
          status: 'completed',
          result: parseResult.resultEvent.result,
          usage: parseResult.resultEvent.usage,
          duration_ms: parseResult.resultEvent.duration_ms,
          total_cost_usd: parseResult.resultEvent.total_cost_usd,
        });
        this.cleanupOutputFiles(entry);
      } else if (alive) {
        // 进程仍在运行，启动后台监控
        logger.info(`Orphaned process PID=${entry.pid} still running, monitoring...`);
        this.monitorOrphanedProcess(entry, onResult);
      } else {
        // 进程已死但没有 result → 通知失败
        logger.warn(`Orphaned process PID=${entry.pid} died without result`);
        await onResult({
          guildId: entry.guildId,
          channelId: entry.channelId,
          lockKey: entry.lockKey,
          status: 'failed',
        });
        this.cleanupOutputFiles(entry);
      }
    }
  }

  private monitorOrphanedProcess(
    entry: ProcessRegistryEntry,
    onResult: (info: ReconnectedResult) => Promise<void>
  ): void {
    const timer = setInterval(async () => {
      const alive = isProcessAlive(entry.pid);
      const parseResult = this.parseOutputFile(entry.outputFile);

      if (parseResult.resultEvent || !alive) {
        clearInterval(timer);
        logger.info(`Orphaned process PID=${entry.pid} ${parseResult.resultEvent ? 'completed' : 'exited'}`);
        await onResult({
          guildId: entry.guildId,
          channelId: entry.channelId,
          lockKey: entry.lockKey,
          claudeSessionId: parseResult.sessionId || entry.claudeSessionId,
          status: parseResult.resultEvent ? 'completed' : 'failed',
          result: parseResult.resultEvent?.result,
          usage: parseResult.resultEvent?.usage,
          duration_ms: parseResult.resultEvent?.duration_ms,
          total_cost_usd: parseResult.resultEvent?.total_cost_usd,
        });
        this.cleanupOutputFiles(entry);
      }
    }, 2000);
  }

  private parseOutputFile(filePath: string): { resultEvent: StreamEvent | null; sessionId: string } {
    try {
      const content = readFileSync(filePath, 'utf-8');
      let resultEvent: StreamEvent | null = null;
      let sessionId = '';
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          if (event.session_id) sessionId = event.session_id;
          if (event.type === 'result') resultEvent = event;
        } catch {}
      }
      return { resultEvent, sessionId };
    } catch {
      return { resultEvent: null, sessionId: '' };
    }
  }

  /**
   * 归档输出文件到 data/sessions/<session_id>/ 目录
   * @returns 归档后的 JSONL 文件路径（绝对路径），失败时返回 null
   */
  private archiveOutputFiles(outputFile: string, stderrFile: string, sessionId: string): string | null {
    if (!sessionId) {
      logger.warn('No session ID, skipping archive');
      return null;
    }

    const thisDir = dirname(fileURLToPath(import.meta.url));
    const archiveDir = join(thisDir, '../../data/sessions', sessionId);
    let archivedJsonlPath: string | null = null;

    try {
      mkdirSync(archiveDir, { recursive: true });

      // 移动 .jsonl 文件
      if (outputFile) {
        try {
          const archivePath = join(archiveDir, basename(outputFile));
          renameSync(outputFile, archivePath);
          archivedJsonlPath = archivePath;
          logger.debug(`Archived output file to ${archivePath}`);
        } catch (e: any) {
          logger.warn(`Failed to archive output file: ${e.message}`);
        }
      }

      // 移动 .stderr 文件
      if (stderrFile) {
        try {
          const archivePath = join(archiveDir, basename(stderrFile));
          renameSync(stderrFile, archivePath);
          logger.debug(`Archived stderr file to ${archivePath}`);
        } catch (e: any) {
          logger.warn(`Failed to archive stderr file: ${e.message}`);
        }
      }
    } catch (e: any) {
      logger.error('Failed to create archive directory:', e);
    }

    return archivedJsonlPath;
  }

  private cleanupOutputFiles(entry: ProcessRegistryEntry): void {
    // 改用归档而非删除
    const sessionId = entry.claudeSessionId || '';
    this.archiveOutputFiles(entry.outputFile, entry.stderrFile, sessionId);

    // 同步到 claude_sessions 表（重连场景）
    if (sessionId && this.onSessionSync) {
      const parseResult = this.parseOutputFile(entry.outputFile);
      const model = parseResult.resultEvent?.modelUsage
        ? Object.keys(parseResult.resultEvent.modelUsage)[0]
        : undefined;
      try {
        this.onSessionSync(sessionId, entry.channelId, model);
      } catch (e: any) {
        logger.warn(`Session sync failed (reconnect): ${e.message}`);
      }
    }
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
