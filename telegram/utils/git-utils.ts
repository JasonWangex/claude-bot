/**
 * Git 工具函数（用于 Fork/Worktree 功能）
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

export async function getRepoName(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
  const topLevel = stdout.trim();
  return topLevel.split('/').pop() || 'repo';
}

export async function createWorktree(cwd: string, targetDir: string, branchName: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'add', targetDir, '-b', branchName], { cwd });
}

export async function mergeBranch(cwd: string, branchName: string): Promise<void> {
  await execFileAsync('git', ['merge', branchName, '--no-edit'], { cwd });
}

export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd });
}

export async function deleteBranch(cwd: string, branchName: string): Promise<void> {
  await execFileAsync('git', ['branch', '-d', branchName], { cwd });
}
