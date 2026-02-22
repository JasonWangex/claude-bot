/**
 * Goal 分支 Git 操作
 *
 * 处理 goal 分支的创建、子任务分支的合并和清理
 */

import { resolve } from 'path';
import { mkdir } from 'fs/promises';
import { logger } from '../utils/logger.js';
import { execGit } from './git-ops.js';

export interface MergeResult {
  success: boolean;
  conflict?: boolean;
  error?: string;
}

/** 获取当前分支名 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const stdout = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'getCurrentBranch');
  return stdout.trim();
}

/** 检查是否有未提交的更改 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const stdout = await execGit(['status', '--porcelain'], cwd, 'hasUncommittedChanges');
  return stdout.trim().length > 0;
}

/** 自动 commit 所有更改 */
export async function autoCommit(cwd: string, message: string): Promise<void> {
  await execGit(['add', '-A'], cwd, 'autoCommit: add');
  await execGit(['commit', '-m', message, '--allow-empty'], cwd, 'autoCommit: commit');
}

/** 检查分支是否存在 */
export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', branchName], cwd, 'branchExists');
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
  const stdout = await execGit(['rev-parse', '--show-toplevel'], baseCwd, 'createGoalBranch: toplevel');
  const repoName = stdout.trim().split('/').pop() || 'repo';
  const worktreeDir = resolve(worktreesDir, `${repoName}-${goalBranch.replace(/\//g, '-')}`);

  await mkdir(worktreesDir, { recursive: true });

  // 如果分支已存在，直接创建 worktree（不带 -b）
  const exists = await branchExists(baseCwd, goalBranch);
  if (exists) {
    await execGit(['worktree', 'add', worktreeDir, goalBranch], baseCwd, 'createGoalBranch: add existing');
  } else {
    await execGit(['worktree', 'add', worktreeDir, '-b', goalBranch], baseCwd, 'createGoalBranch: add new');
  }

  logger.info(`Created goal branch worktree: ${goalBranch} → ${worktreeDir}`);
  return worktreeDir;
}

export interface SubtaskBranchResult {
  worktreeDir: string;
  /** true = 分支/worktree 已存在，本次为复用而非新建 */
  isExisting: boolean;
}

/**
 * 在 goal 分支的 worktree 中创建子任务分支
 *
 * 若分支已存在（上次 dispatch 中途失败等情况）：
 *   - worktree 也存在 → 直接返回已有路径（isExisting=true）
 *   - worktree 不存在 → 以已有分支 attach worktree（isExisting=true）
 * 若分支不存在 → 正常 -b 创建（isExisting=false）
 *
 * @param goalWorktreeDir goal 分支 worktree 目录
 * @param subtaskBranch 子任务分支名
 * @param worktreesDir worktree 根目录
 * @returns SubtaskBranchResult
 */
export async function createSubtaskBranch(
  goalWorktreeDir: string,
  subtaskBranch: string,
  worktreesDir: string
): Promise<SubtaskBranchResult> {
  const stdout = await execGit(['rev-parse', '--show-toplevel'], goalWorktreeDir, 'createSubtaskBranch: toplevel');
  const repoRoot = stdout.trim();
  const repoName = repoRoot.split('/').pop() || 'repo';
  const worktreeDir = resolve(worktreesDir, `${repoName}-${subtaskBranch.replace(/\//g, '-')}`);

  await mkdir(worktreesDir, { recursive: true });

  const exists = await branchExists(goalWorktreeDir, subtaskBranch);
  if (exists) {
    // 检查 worktree 是否已挂载
    const listOutput = await execGit(['worktree', 'list', '--porcelain'], goalWorktreeDir, 'createSubtaskBranch: list');
    const existingDir = findWorktreeDirByBranch(listOutput, subtaskBranch);
    if (existingDir) {
      logger.info(`Subtask branch already has worktree (reusing): ${subtaskBranch} → ${existingDir}`);
      return { worktreeDir: existingDir, isExisting: true };
    }
    // 分支存在但 worktree 未挂载 → attach（不带 -b）
    await execGit(['worktree', 'add', worktreeDir, subtaskBranch], goalWorktreeDir, 'createSubtaskBranch: attach existing');
    logger.info(`Attached worktree to existing branch: ${subtaskBranch} → ${worktreeDir}`);
    return { worktreeDir, isExisting: true };
  }

  // 正常新建
  await execGit(['worktree', 'add', worktreeDir, '-b', subtaskBranch], goalWorktreeDir, 'createSubtaskBranch: add');
  logger.info(`Created subtask branch: ${subtaskBranch} → ${worktreeDir}`);
  return { worktreeDir, isExisting: false };
}

/** 从 worktree list --porcelain 输出中按分支名查找 worktree 目录 */
function findWorktreeDirByBranch(listOutput: string, branchName: string): string | null {
  const lines = listOutput.split('\n');
  let currentPath = '';
  for (const line of lines) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
    if (line.startsWith('branch ') && line.includes(branchName)) return currentPath;
  }
  return null;
}

/**
 * 合并子任务分支到 goal 分支
 *
 * 在 goal worktree 中执行 merge 操作。
 * 冲突时保留冲突状态（不自动 abort），让调用者 abort 后转交 reviewer 处理。
 */
export async function mergeSubtaskBranch(
  goalWorktreeDir: string,
  subtaskBranch: string
): Promise<MergeResult> {
  try {
    await execGit(['merge', subtaskBranch, '--no-edit'], goalWorktreeDir, 'mergeSubtaskBranch');
    return { success: true };
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('CONFLICT') || msg.includes('Automatic merge failed')) {
      // 不自动 abort，保留冲突状态让调用者处理
      return { success: false, conflict: true, error: msg };
    }
    return { success: false, error: msg };
  }
}

/** 中止合并，恢复到 merge 之前的状态 */
export async function abortMerge(cwd: string): Promise<void> {
  try {
    await execGit(['merge', '--abort'], cwd, 'abortMerge');
  } catch {
    // merge --abort 可能失败（如已经不在 merge 状态）
  }
}

/** 获取冲突文件列表 */
export async function getConflictFiles(cwd: string): Promise<string[]> {
  const stdout = await execGit(['diff', '--name-only', '--diff-filter=U'], cwd, 'getConflictFiles');
  return stdout.trim().split('\n').filter(Boolean);
}

/** 检查工作区是否仍有冲突标记 */
export async function hasConflictMarkers(cwd: string): Promise<boolean> {
  try {
    await execGit(['diff', '--check'], cwd, 'hasConflictMarkers');
    return false;
  } catch {
    return true;
  }
}

/** 清理子任务的 worktree 和分支 */
export async function cleanupSubtask(
  baseCwd: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    await execGit(['worktree', 'remove', worktreePath, '--force'], baseCwd, 'cleanupSubtask: remove worktree');
  } catch (err: any) {
    logger.warn(`Failed to remove worktree ${worktreePath}: ${err.message}`);
  }
  try {
    await execGit(['branch', '-d', branchName], baseCwd, 'cleanupSubtask: delete branch');
  } catch (err: any) {
    // -d 可能因未 merge 失败，用 -D 强制删除（因为已经 merge 到 goal 分支了）
    try {
      await execGit(['branch', '-D', branchName], baseCwd, 'cleanupSubtask: force delete branch');
    } catch {
      logger.warn(`Failed to delete branch ${branchName}: ${err.message}`);
    }
  }
}
