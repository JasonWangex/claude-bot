/**
 * Git 工具函数（用于 Fork/Worktree 功能）
 */

import { execGit, resolveMainWorktree } from '../orchestrator/git-ops.js';
import { chatCompletion } from './llm.js';

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--is-inside-work-tree'], cwd, 'isGitRepo');
    return true;
  } catch {
    return false;
  }
}

export async function getRepoName(cwd: string): Promise<string> {
  const stdout = await execGit(['rev-parse', '--show-toplevel'], cwd, 'getRepoName');
  const topLevel = stdout.trim();
  return topLevel.split('/').pop() || 'repo';
}

export async function createWorktree(cwd: string, targetDir: string, branchName: string): Promise<void> {
  await execGit(['worktree', 'add', targetDir, '-b', branchName], cwd, 'createWorktree');
}

export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  await execGit(['worktree', 'remove', worktreePath], cwd, 'removeWorktree');
}

export async function deleteBranch(cwd: string, branchName: string): Promise<void> {
  await execGit(['branch', '-d', branchName], cwd, 'deleteBranch');
}

/**
 * 检查工作目录是否有未提交的改动（包括 staged 和 unstaged）
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const stdout = await execGit(['status', '--porcelain'], cwd, 'hasUncommittedChanges');
  return stdout.trim().length > 0;
}

/**
 * 检查分支是否已合并到 main/master
 */
export async function isBranchMerged(cwd: string, branchName: string): Promise<boolean> {
  const mainCwd = await resolveMainWorktree(cwd);
  const stdout = await execGit(['branch', '--merged', 'main'], mainCwd, 'isBranchMerged');
  const mergedBranches = stdout.split('\n').map(l => l.trim().replace(/^\*\s*/, ''));
  return mergedBranches.includes(branchName);
}

/**
 * 用 DeepSeek 生成 <type>/<kebab-case> 分支名，失败回退时间戳
 */
export async function generateBranchName(description: string): Promise<string> {
  const result = await chatCompletion(
    `Translate the following task description into a git branch name in <type>/<kebab-case> format. The kebab-case part must be at most 4 words (e.g. feat/add-dark-mode, fix/login-null-check). Type must be one of: feat, fix, refactor, perf, chore, docs, test. Output ONLY the branch name, nothing else.\n\nTask: ${description}`,
  );
  if (result) {
    const name = result.trim();
    if (/^[\w]+\/[\w][\w-]*$/.test(name)) {
      return name;
    }
  }
  return `dev/task-${Date.now().toString(36)}`;
}
