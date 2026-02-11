/**
 * Goal 分支 Git 操作
 *
 * 处理 goal 分支的创建、子任务分支的合并和清理
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { mkdir } from 'fs/promises';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface MergeResult {
  success: boolean;
  conflict?: boolean;
  error?: string;
}

/** 获取当前分支名 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

/** 检查是否有未提交的更改 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}

/** 自动 commit 所有更改 */
export async function autoCommit(cwd: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd });
  await execFileAsync('git', ['commit', '-m', message, '--allow-empty'], { cwd });
}

/** 检查分支是否存在 */
export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', branchName], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 goal 分支及其 worktree
 *
 * @returns worktree 目录路径
 */
export async function createGoalBranch(
  baseCwd: string,
  goalBranch: string,
  worktreesDir: string
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: baseCwd });
  const repoName = stdout.trim().split('/').pop() || 'repo';
  const worktreeDir = resolve(worktreesDir, `${repoName}_${goalBranch.replace(/\//g, '_')}`);

  await mkdir(worktreesDir, { recursive: true });

  // 如果分支已存在，直接创建 worktree（不带 -b）
  const exists = await branchExists(baseCwd, goalBranch);
  if (exists) {
    await execFileAsync('git', ['worktree', 'add', worktreeDir, goalBranch], { cwd: baseCwd });
  } else {
    await execFileAsync('git', ['worktree', 'add', worktreeDir, '-b', goalBranch], { cwd: baseCwd });
  }

  logger.info(`Created goal branch worktree: ${goalBranch} → ${worktreeDir}`);
  return worktreeDir;
}

/**
 * 在 goal 分支的 worktree 中创建子任务分支
 *
 * @param goalWorktreeDir goal 分支 worktree 目录
 * @param subtaskBranch 子任务分支名
 * @param worktreesDir worktree 根目录
 * @returns 子任务 worktree 目录路径
 */
export async function createSubtaskBranch(
  goalWorktreeDir: string,
  subtaskBranch: string,
  worktreesDir: string
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: goalWorktreeDir });
  const repoRoot = stdout.trim();
  const repoName = repoRoot.split('/').pop() || 'repo';
  const worktreeDir = resolve(worktreesDir, `${repoName}_${subtaskBranch.replace(/\//g, '_')}`);

  await mkdir(worktreesDir, { recursive: true });
  // 从 goal 分支 fork 出子任务分支
  await execFileAsync('git', ['worktree', 'add', worktreeDir, '-b', subtaskBranch], { cwd: goalWorktreeDir });

  logger.info(`Created subtask branch: ${subtaskBranch} → ${worktreeDir}`);
  return worktreeDir;
}

/**
 * 合并子任务分支到 goal 分支
 *
 * 在 goal worktree 中执行 merge 操作
 */
export async function mergeSubtaskBranch(
  goalWorktreeDir: string,
  subtaskBranch: string
): Promise<MergeResult> {
  try {
    await execFileAsync('git', ['merge', subtaskBranch, '--no-edit'], { cwd: goalWorktreeDir });
    return { success: true };
  } catch (err: any) {
    // 检查是否为合并冲突
    const msg = err.stderr || err.message || '';
    if (msg.includes('CONFLICT') || msg.includes('Automatic merge failed')) {
      // 回滚 merge
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: goalWorktreeDir });
      } catch {
        // merge --abort 也可能失败
      }
      return { success: false, conflict: true, error: msg };
    }
    return { success: false, error: msg };
  }
}

/** 清理子任务的 worktree 和分支 */
export async function cleanupSubtask(
  baseCwd: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: baseCwd });
  } catch (err: any) {
    logger.warn(`Failed to remove worktree ${worktreePath}: ${err.message}`);
  }
  try {
    await execFileAsync('git', ['branch', '-d', branchName], { cwd: baseCwd });
  } catch (err: any) {
    // -d 可能因未 merge 失败，用 -D 强制删除（因为已经 merge 到 goal 分支了）
    try {
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: baseCwd });
    } catch {
      logger.warn(`Failed to delete branch ${branchName}: ${err.message}`);
    }
  }
}
