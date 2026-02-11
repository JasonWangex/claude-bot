/**
 * Git 操作统一包装
 *
 * 所有 git 命令调用经过此模块，提供：
 * 1. cwd 目录存在性验证（防止 spawn git ENOENT）
 * 2. 含上下文的清晰错误消息
 * 3. baseCwd 规范化（解析到 main worktree 根目录）
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export class GitOperationError extends Error {
  constructor(
    message: string,
    public readonly cwd: string,
    public readonly command: string[],
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

/**
 * 安全执行 git 命令，执行前验证 cwd 存在
 */
export async function execGit(
  args: string[],
  cwd: string,
  context: string
): Promise<string> {
  try {
    await stat(cwd);
  } catch {
    throw new GitOperationError(
      `${context}: cwd does not exist: ${cwd}`,
      cwd,
      ['git', ...args]
    );
  }

  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  } catch (err: any) {
    const errorMsg = err.stderr?.trim() || err.message || 'Unknown error';
    throw new GitOperationError(
      `${context}: git ${args.join(' ')} failed (cwd: ${cwd}): ${errorMsg}`,
      cwd,
      ['git', ...args],
      err
    );
  }
}

/**
 * 从任意 repo/worktree 路径解析到 main worktree 根目录
 *
 * 这确保 baseCwd 始终指向稳定的主仓库目录，
 * 而非可能被删除的 worktree 路径。
 */
export async function resolveMainWorktree(inputCwd: string): Promise<string> {
  const stdout = await execGit(
    ['worktree', 'list', '--porcelain'],
    inputCwd,
    'resolveMainWorktree'
  );

  // 第一个 worktree 条目就是 main worktree
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      return line.slice('worktree '.length);
    }
  }

  // 降级：返回 repo root
  const root = await execGit(
    ['rev-parse', '--show-toplevel'],
    inputCwd,
    'resolveMainWorktree: fallback'
  );
  return root.trim();
}
