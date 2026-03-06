/**
 * Rollback 处理器
 *
 * 从 GoalOrchestrator 提取的回滚逻辑。
 * 支持两阶段回滚：先评估成本（rollback），再确认执行（confirmRollback）或取消（cancelRollback）。
 */

import type { GoalDriveState, GoalTask, PendingRollback } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { StateManager } from '../bot/state.js';
import { logger } from '../utils/logger.js';
import { execGit } from './git-ops.js';
import { cleanupSubtask } from './goal-branch.js';
import { buildRollbackConfirmButtons } from './goal-buttons.js';
import { updateGoalBodyWithTasks } from './goal-body-utils.js';

/**
 * 第一阶段：评估回滚成本，暂停受影响任务，等待用户确认
 */
export async function rollback(
  ctx: GoalOrchestrator,
  goalId: string,
  checkpointId: string,
): Promise<PendingRollback | null> {
  return await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) {
      logger.error(`[Orchestrator] rollback: goal ${goalId} not found`);
      return null;
    }

    if (state.pendingRollback) {
      await ctx.notifyGoal(state,
        `已有待确认的回滚操作（检查点: \`${state.pendingRollback.checkpointId}\`）\n` +
        `请先 \`confirm rollback\` 或 \`cancel rollback\``,
        'warning',
      );
      return null;
    }

    // 1. 加载检查点
    const checkpoint = await ctx.deps.checkpointRepo.get(checkpointId);
    if (!checkpoint) {
      await ctx.notifyGoal(state, `检查点 \`${checkpointId}\` 不存在`, 'error');
      return null;
    }
    if (checkpoint.goalId !== goalId) {
      await ctx.notifyGoal(state, `检查点 \`${checkpointId}\` 不属于此 Goal`, 'error');
      return null;
    }
    if (!checkpoint.tasksSnapshot) {
      await ctx.notifyGoal(state, `检查点 \`${checkpointId}\` 没有任务快照`, 'error');
      return null;
    }

    // 2. 确定受影响的任务：快照中不存在 或 快照中状态不是 completed/merged 但现在有进展的任务
    const snapshotTaskIds = new Set(checkpoint.tasksSnapshot.map(t => t.id));
    const snapshotTaskMap = new Map(checkpoint.tasksSnapshot.map(t => [t.id, t]));

    const affectedTasks: PendingRollback['affectedTasks'] = [];
    const pausedTaskIds: string[] = [];

    for (const task of state.tasks) {
      // 快照中不存在的任务（replan 后新增的）→ 受影响
      if (!snapshotTaskIds.has(task.id)) {
        if (task.status === 'running' || task.status === 'dispatched' ||
            task.status === 'completed' || task.status === 'paused') {
          affectedTasks.push({
            id: task.id,
            description: task.description,
            previousStatus: task.status,
            runtime: task.dispatchedAt ? Date.now() - task.dispatchedAt : undefined,
          });
        }
        continue;
      }

      // 快照中存在的任务：比较状态变化
      const snapshotTask = snapshotTaskMap.get(task.id)!;
      const statusChanged = task.status !== snapshotTask.status;
      const hasProgress = (
        task.status === 'running' || task.status === 'dispatched' ||
        (task.status === 'completed' && snapshotTask.status !== 'completed')
      );

      if (statusChanged && hasProgress) {
        affectedTasks.push({
          id: task.id,
          description: task.description,
          previousStatus: task.status,
          runtime: task.dispatchedAt ? Date.now() - task.dispatchedAt : undefined,
        });
      }
    }

    // 3. Pause 所有正在运行的受影响任务
    const guildId = ctx.getGuildId();
    for (const affected of affectedTasks) {
      const task = state.tasks.find(t => t.id === affected.id);
      if (!task) continue;

      if (task.status === 'running') {
        // 中止 Claude 进程
        if (task.channelId && guildId) {
          const lockKey = StateManager.channelLockKey(guildId, task.channelId);
          ctx.deps.claudeClient.abort(lockKey);
        }
        task.status = 'paused';
        pausedTaskIds.push(task.id);
      } else if (task.status === 'dispatched') {
        task.status = 'paused';
        pausedTaskIds.push(task.id);
      }
    }

    // 4. 收集 git diff stats（评估代码产出量）
    const worktreeListOutput = await ctx.safeListWorktrees(state.baseCwd);
    for (const affected of affectedTasks) {
      const task = state.tasks.find(t => t.id === affected.id);
      if (!task?.branchName || !worktreeListOutput) continue;

      try {
        const goalWorktreeDir = ctx.findWorktreeDir(worktreeListOutput, state.goalBranch);
        if (goalWorktreeDir) {
          const diffStat = await execGit(
            ['diff', '--stat', `${state.goalBranch}...${task.branchName}`],
            goalWorktreeDir,
            `rollback: diff stat for ${task.id}`,
          );
          if (diffStat.trim()) {
            affected.diffStat = diffStat.trim();
          }
        }
      } catch {
        // diff stat 失败不阻塞回滚流程
      }
    }

    // 5. 生成成本摘要
    const costSummary = buildRollbackCostSummary(affectedTasks, checkpoint);

    // 6. 构建 PendingRollback 并存入 state
    const pendingRollback: PendingRollback = {
      checkpointId,
      pausedTaskIds,
      costSummary,
      affectedTasks,
      createdAt: Date.now(),
    };

    state.pendingRollback = pendingRollback;
    await ctx.saveState(state);

    // 7. 通知用户确认（含确认/取消按钮）
    const confirmMessage =
      `⏪ **回滚评估：检查点 \`${checkpointId}\`**\n\n` +
      costSummary;

    await ctx.notifyGoal(state, confirmMessage, 'warning', {
      components: buildRollbackConfirmButtons(goalId),
    });

    return pendingRollback;
  });
}

/**
 * 确认回滚（第二阶段：执行）
 *
 * 1. stop 所有受影响任务的进程
 * 2. restoreCheckpoint 恢复任务计划
 * 3. git reset goal 分支到检查点 commit
 * 4. 清理受影响任务的 worktree/分支/Discord channel
 * 5. 恢复调度
 */
export async function confirmRollback(
  ctx: GoalOrchestrator,
  goalId: string,
): Promise<boolean> {
  return await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) return false;

    const pending = state.pendingRollback;
    if (!pending) {
      await ctx.notifyGoal(state, '没有待确认的回滚操作', 'info');
      return false;
    }

    const guildId = ctx.getGuildId();

    // 1. 恢复检查点的任务快照
    const snapshotTasks = await ctx.deps.checkpointRepo.restoreCheckpoint(pending.checkpointId);
    if (!snapshotTasks) {
      // 检查点不可用 → 恢复第一阶段被暂停的任务，避免任务永远卡在 paused
      for (const taskId of pending.pausedTaskIds) {
        const task = state.tasks.find(t => t.id === taskId);
        if (task && task.status === 'paused') {
          task.status = 'pending';
          task.branchName = undefined;
          task.channelId = undefined;
          task.dispatchedAt = undefined;
        }
      }
      delete state.pendingRollback;
      await ctx.saveState(state);
      const pausedList = pending.pausedTaskIds.length > 0
        ? `\n已恢复暂停任务：${pending.pausedTaskIds.join(', ')}`
        : '';
      await ctx.notifyGoal(state,
        `回滚失败：检查点 \`${pending.checkpointId}\` 快照数据不可用${pausedList}`,
        'error',
      );
      return false;
    }

    // 2. 收集需要清理的任务（当前 state 中有 branch/thread 但快照中不存在或状态不同的任务）
    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));
    const tasksToCleanup: GoalTask[] = [];

    for (const task of state.tasks) {
      const snapshotTask = snapshotTaskMap.get(task.id);

      // 任务在快照中不存在（replan 新增的）→ 需要清理
      if (!snapshotTask) {
        if (task.branchName || task.channelId) {
          tasksToCleanup.push(task);
        }
        continue;
      }

      // 任务在快照中是 pending 但现在有 branch/thread → 需要清理
      if (snapshotTask.status === 'pending' && (task.branchName || task.channelId)) {
        tasksToCleanup.push(task);
      }
    }

    // 3. 清理受影响任务的资源（stop 进程 + 删除 worktree/分支 + 删除 Discord channel）
    const worktreeListOutput = await ctx.safeListWorktrees(state.baseCwd);

    for (const task of tasksToCleanup) {
      // 停止进程
      if (task.channelId && guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        ctx.deps.claudeClient.abort(lockKey);
      }

      // 清理 worktree 和分支
      if (task.branchName && worktreeListOutput) {
        const subtaskDir = ctx.findWorktreeDir(worktreeListOutput, task.branchName);
        if (subtaskDir) {
          try {
            await cleanupSubtask(state.baseCwd, subtaskDir, task.branchName);
          } catch (err: any) {
            logger.warn(`[Orchestrator] rollback: cleanup failed for ${task.id}: ${err.message}`);
          }
        } else {
          // worktree 可能已不存在，尝试只删除分支
          try {
            await execGit(['branch', '-D', task.branchName], state.baseCwd,
              `rollback: force delete branch ${task.branchName}`);
          } catch { /* ignore */ }
        }
      }

      // 删除 Discord channel
      if (task.channelId) {
        if (guildId) {
          ctx.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'rollback');
        }
        try {
          const channel = await ctx.deps.client.channels.fetch(task.channelId);
          if (channel && 'delete' in channel) {
            await (channel as any).delete('Rolled back').catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }

    // 4. Git reset goal 分支到检查点 commit（如果检查点有 gitRef）
    const checkpoint = await ctx.deps.checkpointRepo.get(pending.checkpointId);
    if (checkpoint?.gitRef && worktreeListOutput) {
      const goalWorktreeDir = ctx.findWorktreeDir(worktreeListOutput, state.goalBranch);
      if (goalWorktreeDir) {
        try {
          await execGit(['reset', '--hard', checkpoint.gitRef], goalWorktreeDir,
            `rollback: reset goal branch to ${checkpoint.gitRef}`);
          logger.info(`[Orchestrator] rollback: reset ${state.goalBranch} to ${checkpoint.gitRef}`);
        } catch (err: any) {
          logger.warn(`[Orchestrator] rollback: git reset failed: ${err.message}`);
          await ctx.notifyGoal(state,
            `Git reset 失败: ${err.message}\n任务计划已恢复，但 git 历史可能需要手动处理`,
            'warning',
          );
        }
      }
    }

    // 5. 恢复任务列表
    state.tasks = snapshotTasks;
    delete state.pendingRollback;

    // 确保 goal 状态可恢复调度
    if (state.status === 'paused') {
      state.status = 'running';
    }

    // 持久化
    await ctx.deps.taskRepo.saveAll(snapshotTasks, state.goalId);
    await ctx.saveState(state);

    // 更新 Goal body
    const goalMeta = await ctx.deps.goalMetaRepo.get(state.goalId);
    if (goalMeta) {
      goalMeta.body = updateGoalBodyWithTasks(goalMeta.body, snapshotTasks);
      const total = snapshotTasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
      const completed = snapshotTasks.filter(t => t.status === 'completed' && (!t.branchName || t.merged)).length;
      const running = snapshotTasks.filter(t => t.status === 'dispatched' || t.status === 'running').length;
      const failed = snapshotTasks.filter(t => t.status === 'failed').length;
      goalMeta.progress = JSON.stringify({ completed, total, running, failed });
      await ctx.deps.goalMetaRepo.save(goalMeta);
    }

    const cleanedCount = tasksToCleanup.length;
    await ctx.notifyGoal(state,
      `✅ **回滚完成**\n` +
      `已恢复到检查点 \`${pending.checkpointId}\`\n` +
      `清理了 ${cleanedCount} 个受影响任务的资源\n` +
      `任务计划已恢复，继续调度...`,
      'success',
    );

    // 6. 恢复调度
    if (state.status === 'running') {
      await ctx.reviewAndDispatch(state);
    }

    return true;
  });
}

/**
 * 取消回滚：恢复已暂停的任务
 */
export async function cancelRollback(
  ctx: GoalOrchestrator,
  goalId: string,
): Promise<boolean> {
  return await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) return false;

    const pending = state.pendingRollback;
    if (!pending) {
      await ctx.notifyGoal(state, '没有待确认的回滚操作', 'info');
      return false;
    }

    const guildId = ctx.getGuildId();

    // 恢复被暂停的任务
    for (const taskId of pending.pausedTaskIds) {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'paused') continue;

      // 找回原始状态
      const affected = pending.affectedTasks.find(a => a.id === taskId);
      if (affected && (affected.previousStatus === 'running' || affected.previousStatus === 'dispatched')) {
        // 重新设为 pending 让调度器重新分发
        task.status = 'pending';
        task.branchName = undefined;
        task.channelId = undefined;
        task.dispatchedAt = undefined;
      }
    }

    delete state.pendingRollback;
    await ctx.saveState(state);

    await ctx.notifyGoal(state,
      `🚫 **回滚已取消**\n已暂停的任务将重新派发（之前的执行进度无法恢复）`,
      'info',
    );

    // 恢复调度
    if (state.status === 'running') {
      await ctx.reviewAndDispatch(state);
    }

    return true;
  });
}

/**
 * 生成回滚成本评估摘要（纯函数，无需 ctx）
 */
export function buildRollbackCostSummary(
  affectedTasks: PendingRollback['affectedTasks'],
  checkpoint: import('../types/index.js').GoalCheckpoint,
): string {
  const lines: string[] = [];

  const checkpointAge = Date.now() - checkpoint.createdAt;
  const ageMinutes = Math.floor(checkpointAge / 60_000);
  const ageStr = ageMinutes < 60
    ? `${ageMinutes} 分钟前`
    : `${Math.floor(ageMinutes / 60)} 小时 ${ageMinutes % 60} 分钟前`;

  lines.push(`**检查点信息**`);
  lines.push(`- 创建时间: ${ageStr}`);
  lines.push(`- 触发: ${checkpoint.trigger}`);
  if (checkpoint.reason) {
    lines.push(`- 原因: ${checkpoint.reason}`);
  }
  lines.push('');

  if (affectedTasks.length === 0) {
    lines.push('**无受影响任务** — 回滚仅恢复任务计划');
    return lines.join('\n');
  }

  lines.push(`**受影响任务 (${affectedTasks.length} 个):**`);
  for (const task of affectedTasks) {
    const runtimeStr = task.runtime
      ? ` (运行 ${Math.floor(task.runtime / 60_000)} 分钟)`
      : '';
    const diffStr = task.diffStat
      ? `\n  \`\`\`\n  ${task.diffStat.split('\n').slice(-1)[0]}\n  \`\`\``
      : '';
    lines.push(`- **${task.id}** [${task.previousStatus}] ${task.description}${runtimeStr}${diffStr}`);
  }

  // 汇总
  const totalRuntime = affectedTasks.reduce((sum, t) => sum + (t.runtime || 0), 0);
  if (totalRuntime > 0) {
    lines.push('');
    lines.push(`**总计运行时间:** ${Math.floor(totalRuntime / 60_000)} 分钟`);
  }

  return lines.join('\n');
}
