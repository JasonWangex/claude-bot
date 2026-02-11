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

/**
 * 用 claude -p (Sonnet) 生成 <type>/<kebab-case> 分支名，15s 超时，失败回退时间戳
 */
export async function generateBranchName(description: string): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const prompt = `Translate the following task description into a git branch name in <type>/<kebab-case> format. Type must be one of: feat, fix, refactor, perf, chore, docs, test. Output ONLY the branch name, nothing else.\n\nTask: ${description}`;
  try {
    const { stdout } = await execFileAsync('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--max-turns', '1',
      '--model', 'claude-sonnet-4-5-20250929',
    ], { timeout: 15000 });
    const name = stdout.trim();
    if (/^[\w]+\/[\w][\w-]*$/.test(name)) {
      return name;
    }
  } catch { /* fall through */ }
  return `dev/task-${Date.now().toString(36)}`;
}
