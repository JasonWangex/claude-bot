/**
 * AI 自动解决 Git 合并冲突
 *
 * 当子任务合并到 goal 分支产生冲突时，调用 Claude 分析冲突文件并自动解决。
 * 如果 AI 无法解决，返回失败让调用者 fallback 到人工干预。
 */

import type { ClaudeClient } from '../claude/client.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';
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
  promptService: PromptConfigService,
): Promise<ConflictResolutionResult> {
  try {
    const conflictFiles = await getConflictFiles(goalWorktreeDir);
    if (conflictFiles.length === 0) {
      await abortMerge(goalWorktreeDir);
      return { resolved: false, error: 'No conflict files detected' };
    }

    logger.info(`[ConflictResolver] Resolving ${conflictFiles.length} conflicted files: ${conflictFiles.join(', ')}`);

    const filesList = conflictFiles.map(f => `- ${f}`).join('\n');
    const prompt = promptService.render('orchestrator.conflict_resolver', {
      SUBTASK_BRANCH: subtaskBranch,
      TASK_DESCRIPTION: taskDescription,
      CONFLICT_FILES: filesList,
    });

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
