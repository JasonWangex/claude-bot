/**
 * AI 自动解决 Git 合并冲突
 *
 * 当子任务合并到 goal 分支产生冲突时，调用 Claude 分析冲突文件并自动解决。
 * 如果 AI 无法解决，返回失败让调用者 fallback 到人工干预。
 */

import type { ClaudeClient } from '../claude/client.js';
import { logger } from '../utils/logger.js';
import { execGit } from './git-ops.js';
import { getConflictFiles, hasConflictMarkers, abortMerge } from './goal-branch.js';

export interface ConflictResolutionResult {
  resolved: boolean;
  error?: string;
}

/**
 * 尝试用 AI 解决当前 merge 冲突
 *
 * 前提：goalWorktreeDir 处于 merge 冲突状态（未 abort）
 * 成功时：冲突已解决并 commit，返回 { resolved: true }
 * 失败时：已 abort merge 恢复干净状态，返回 { resolved: false }
 */
export async function resolveConflictsWithAI(
  claudeClient: ClaudeClient,
  goalWorktreeDir: string,
  subtaskBranch: string,
  taskDescription: string,
): Promise<ConflictResolutionResult> {
  try {
    const conflictFiles = await getConflictFiles(goalWorktreeDir);
    if (conflictFiles.length === 0) {
      await abortMerge(goalWorktreeDir);
      return { resolved: false, error: 'No conflict files detected' };
    }

    logger.info(`[ConflictResolver] Resolving ${conflictFiles.length} conflicted files: ${conflictFiles.join(', ')}`);

    const prompt = buildPrompt(conflictFiles, subtaskBranch, taskDescription);

    await claudeClient.chat(prompt, {
      cwd: goalWorktreeDir,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      lockKey: `conflict-${Date.now()}`,
    });

    // 验证冲突标记是否全部清除
    const stillConflicted = await hasConflictMarkers(goalWorktreeDir);
    if (stillConflicted) {
      logger.warn('[ConflictResolver] AI did not resolve all conflict markers');
      await abortMerge(goalWorktreeDir);
      return { resolved: false, error: 'AI failed to resolve all conflict markers' };
    }

    // Stage 并完成 merge commit
    await execGit(['add', '-A'], goalWorktreeDir, 'conflict-resolver: stage resolved files');
    await execGit(
      ['commit', '--no-edit'],
      goalWorktreeDir,
      'conflict-resolver: complete merge commit',
    );

    logger.info('[ConflictResolver] Conflict resolved successfully');
    return { resolved: true };
  } catch (err: any) {
    logger.error(`[ConflictResolver] Failed: ${err.message}`);
    await abortMerge(goalWorktreeDir);
    return { resolved: false, error: err.message };
  }
}

function buildPrompt(
  conflictFiles: string[],
  subtaskBranch: string,
  taskDescription: string,
): string {
  return [
    `You are resolving Git merge conflicts. Branch \`${subtaskBranch}\` is being merged into the current branch.`,
    ``,
    `Subtask description: ${taskDescription}`,
    ``,
    `The following files have conflicts:`,
    ...conflictFiles.map(f => `- ${f}`),
    ``,
    `Instructions:`,
    `1. Read each conflicted file to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>>)`,
    `2. HEAD is the current goal branch (accumulated work from other subtasks)`,
    `3. The incoming changes are from the subtask branch (the work described above)`,
    `4. Resolve by keeping BOTH sides' valid changes — do not discard either side's work`,
    `5. Use the Edit tool to fix each file, removing all conflict markers`,
    ``,
    `Common patterns:`,
    `- Import conflicts: keep all imports from both sides`,
    `- package.json / config files: merge both sets of entries`,
    `- Adjacent code changes: include both additions in the correct order`,
    `- Same function modified: carefully combine the logic from both sides`,
    ``,
    `Rules:`,
    `- Do NOT run git add, git commit, or any git commands`,
    `- Do NOT run install, build, or test commands`,
    `- ONLY edit the conflicted files to resolve the conflicts`,
  ].join('\n');
}
