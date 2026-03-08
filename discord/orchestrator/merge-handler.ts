import type { GoalDriveState, GoalTask } from '../types/index.js';
import { PipelinePhase } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { NotifyType } from './orchestrator-types.js';
import { execGit } from './git-ops.js';
import {
  mergeSubtaskBranch,
  cleanupSubtask,
  hasUncommittedChanges,
  autoCommit,
  abortMerge,
} from './goal-branch.js';
import { logger } from '../utils/logger.js';
import { TaskEventType } from '../db/repo/task-event-repo.js';

/**
 * 删除子任务的 Discord channel（归档 session + 调用 Discord API 删除）。
 * merge-handler 和 review-handler 的 conflict resolution 路径均需要此操作。
 */
export async function cleanupTaskChannel(
  ctx: GoalOrchestrator,
  task: GoalTask,
  guildId: string,
): Promise<void> {
  if (!task.channelId) return;
  ctx.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'merged');
  try {
    const channel = await ctx.deps.client.channels.fetch(task.channelId);
    if (channel && 'delete' in channel) {
      await (channel as { delete(reason?: string): Promise<unknown> }).delete('Task merged and cleaned up').catch(() => {});
    }
  } catch { /* ignore — channel may already be deleted */ }
}

export async function mergeAndCleanup(ctx: GoalOrchestrator, state: GoalDriveState, task: GoalTask): Promise<void> {
  if (!task.branchName) return;

  // Per-goal merge lock: queue merges for the same goal, allow different goals concurrently
  const goalId = state.goalId;
  const prev = ctx.mergeLocks.get(goalId) || Promise.resolve();
  const current = prev.then(() => doMergeAndCleanup(ctx, state, task)).catch(() => {});
  ctx.mergeLocks.set(goalId, current);
  await current;
}

export async function doMergeAndCleanup(ctx: GoalOrchestrator, state: GoalDriveState, task: GoalTask): Promise<void> {
  if (!task.branchName) return;
  const branchName = task.branchName;
  // 提到 try 外部，确保 catch 块也能访问，用于提交 merge.conflict 事件
  let goalWorktreeDir: string | undefined;
  let subtaskDir: string | undefined;

  try {
    const stdout = await execGit(
      ['worktree', 'list', '--porcelain'],
      state.cwd,
      `mergeAndCleanup(${branchName}): list worktrees`
    );
    goalWorktreeDir = ctx.findWorktreeDir(stdout, state.branch) ?? undefined;
    if (!goalWorktreeDir) {
      await ctx.notifyGoal(state, `Cannot find goal worktree, skipping merge: ${branchName}`, NotifyType.Warning);
      return;
    }

    subtaskDir = ctx.findWorktreeDir(stdout, branchName) ?? undefined;
    if (subtaskDir) {
      const hasChanges = await hasUncommittedChanges(subtaskDir);
      if (hasChanges) {
        logger.warn(`[MergeHandler] Auto-committing uncommitted changes in ${subtaskDir} for task ${task.id}`);
        await autoCommit(subtaskDir, `auto: ${task.description}`);
        await ctx.notifyGoal(state,
          `Task ${task.id} 有未提交的修改，已自动 commit。请检查是否正常。`,
          NotifyType.Warning,
        );
      }
    }

    const result = await mergeSubtaskBranch(goalWorktreeDir, branchName);

    if (result.success) {
      task.merged = true;
      ctx.clearTechLeadNudgeState(task.id);

      // 关闭 audit session（hidden session，只需归档内存 session，无 Discord channel）
      const guildIdForAudit = ctx.getGuildId();
      if (guildIdForAudit && task.auditSessionKey) {
        ctx.deps.stateManager.archiveSession(guildIdForAudit, task.auditSessionKey, undefined, 'merged');
        task.auditSessionKey = undefined;
      }

      await ctx.saveState(state);
      await ctx.notifyGoal(state, `Merged: \`${branchName}\` → \`${state.branch}\``, NotifyType.Success);

      if (subtaskDir) {
        await cleanupSubtask(state.cwd, subtaskDir, branchName);
      }

      // Delete subtask channel
      const guildIdForChannel = ctx.getGuildId();
      if (guildIdForChannel) {
        await cleanupTaskChannel(ctx, task, guildIdForChannel);
      }
    } else {
      // 无论是真正的 conflict 还是其他 merge 失败，统一交由 tech lead 处理
      const reason = result.conflict
        ? `Merge conflict`
        : `Merge failed (treated as conflict): ${result.error ?? 'unknown error'}`;
      await abortMerge(goalWorktreeDir);
      await ctx.notifyGoal(state,
        `${reason}: \`${branchName}\` → \`${state.branch}\`. Queued for tech lead...`,
        NotifyType.Warning
      );
      ctx.deps.taskEventRepo.write(task.id, state.goalId, TaskEventType.MergeConflict, {
        branchName,
        goalWorktreeDir,
        subtaskDir: subtaskDir ?? null,
        taskDescription: task.description,
      }, 'orchestrator');
      // task 保持 completed 状态（execution done，merge pending）；标记 conflict 阶段供轻推机制识别
      task.pipelinePhase = PipelinePhase.Conflict;
      await ctx.saveState(state);
    }
  } catch (err: any) {
    logger.error('[Orchestrator] mergeAndCleanup error:', err);
    // 任何异常都视为 conflict，提交事件交由 tech lead 处理（前提是已知 goalWorktreeDir）
    if (goalWorktreeDir) {
      await abortMerge(goalWorktreeDir);
      await ctx.notifyGoal(state,
        `Merge exception (treated as conflict): \`${branchName}\` → \`${state.branch}\`. Queued for tech lead...\nError: ${err.message}`,
        NotifyType.Warning
      );
      ctx.deps.taskEventRepo.write(task.id, state.goalId, TaskEventType.MergeConflict, {
        branchName,
        goalWorktreeDir,
        subtaskDir: subtaskDir ?? null,
        taskDescription: task.description,
      }, 'orchestrator');
      task.pipelinePhase = PipelinePhase.Conflict;
      await ctx.saveState(state);
    }
  }
}
