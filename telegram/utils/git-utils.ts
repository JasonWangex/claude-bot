/**
 * Git 工具函数（用于 Fork/Worktree 功能）
 */

import { execGit } from '../orchestrator/git-ops.js';

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
