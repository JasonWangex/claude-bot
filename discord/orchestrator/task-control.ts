/**
 * Task control functions extracted from GoalOrchestrator.
 *
 * Each function takes `ctx: GoalOrchestrator` as its first parameter
 * so the orchestrator instance can delegate here without losing access
 * to state, deps, or helper methods.
 */

import { DiscordAPIError } from 'discord.js';
import type { GoalOrchestrator } from './index.js';
import type { GoalTask } from '../types/index.js';
import { StateManager } from '../bot/state.js';
import { logger } from '../utils/logger.js';

export async function skipTask(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return false;
  if (task.status !== 'pending' && task.status !== 'blocked' && task.status !== 'failed' && task.status !== 'paused') return false;

  // paused 任务可能有关联的进程，先清理
  if (task.status === 'paused' && task.channelId) {
    const guildId = ctx.getGuildId();
    if (guildId) {
      const lockKey = StateManager.channelLockKey(guildId, task.channelId);
      ctx.deps.claudeClient.abort(lockKey);
    }
  }

  task.status = 'skipped';
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Skipped task: ${ctx.getTaskLabel(state, task.id)} - ${task.description}`, 'info');
  if (state.status === 'running') await ctx.reviewAndDispatch(state);
  return true;
}

export async function markTaskDone(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'blocked') return false;
  task.status = 'completed';
  task.completedAt = Date.now();
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Manual task completed: ${ctx.getTaskLabel(state, task.id)} - ${task.description}`, 'success');
  if (state.status === 'running') await ctx.reviewAndDispatch(state, taskId);
  return true;
}

/**
 * 轻量重试：保留 channel/branch 上下文，在原有 channel 中继续执行。
 * 有 channel 上下文则原地 resume，无上下文则轻量重置后重新派发。
 * 适用于任务失败后希望在原 thread 中继续的场景。
 * 如需完全从头开始，请使用 resetAndStart。
 */
export async function retryTask(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return false;
  if (task.status !== 'failed' && task.status !== 'blocked_feedback' && task.status !== 'paused') return false;

  const guildId = ctx.getGuildId();
  if (!guildId) return false;

  // 有 channel 上下文 → 先验证 channel 是否仍存在
  if (task.channelId) {
    const guild = await ctx.deps.client.guilds.fetch(guildId);
    let channel = null;
    try {
      channel = await guild.channels.fetch(task.channelId);
    } catch (err) {
      if (!(err instanceof DiscordAPIError && err.code === 10003)) throw err;
      // code 10003 = Unknown Channel → channel 已删除，fall through 重新派发
    }

    if (channel) {
      // channel 存在 → 保留 branch/thread，在原 channel 中 resume
      const lockKey = StateManager.channelLockKey(guildId, task.channelId);
      ctx.deps.claudeClient.abort(lockKey);

      const savedError = task.error;
      task.status = 'running';
      task.error = undefined;
      task.pipelinePhase = 'execute';
      task.feedback = undefined;
      task.auditRetries = 0;
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Retrying task (resume): ${ctx.getTaskLabel(state, task.id)} - ${task.description}`,
        'warning',
      );
      const errorHint = savedError ? `\n上次错误：${savedError}` : '';
      const prompt = `[Retry] 任务${errorHint ? '因以下原因失败，请修正后继续' : '恢复执行'}。${errorHint}\n请检查工作区现有进度并继续完成任务。`;
      ctx.executeTaskInBackground(goalId, taskId, guildId, task.channelId, prompt);
      return true;
    }

    // channel 已不存在 → 清空 channelId，保留 branchName，走重新派发
    logger.warn(`[Orchestrator] retryTask: channel ${task.channelId} not found for task ${taskId}, will create new channel`);
    task.channelId = undefined;
  }

  // 无有效 channel → 轻量重置后重新派发（不清除统计数据）
  // 注意：branchName 保留，dispatchTask 会独立检查分支是否存在，缺什么补什么
  task.status = 'pending';
  task.error = undefined;
  task.channelId = undefined;
  task.dispatchedAt = undefined;
  task.feedback = undefined;
  task.pipelinePhase = undefined;
  task.auditRetries = 0;
  ctx.deps.taskEventRepo.clearByTask(taskId);
  ctx.clearCheckInState(taskId);
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Retrying task (re-dispatch): ${ctx.getTaskLabel(state, task.id)} - ${task.description}`, 'warning');
  if (state.status === 'running') await ctx.reviewAndDispatch(state);
  return true;
}

/**
 * 完全重试：清空所有上下文和统计数据，从头开始派发新的 branch/thread。
 * 适用于需要完全重来的场景（如分支严重冲突、需要换方向等）。
 */
export async function resetAndStart(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return false;
  if (task.status !== 'failed' && task.status !== 'blocked_feedback' && task.status !== 'paused') return false;

  if (task.channelId) {
    const guildId = ctx.getGuildId();
    if (guildId) {
      const lockKey = StateManager.channelLockKey(guildId, task.channelId);
      ctx.deps.claudeClient.abort(lockKey);
    }
  }

  task.status = 'pending';
  task.error = undefined;
  task.branchName = undefined;
  task.channelId = undefined;
  task.dispatchedAt = undefined;
  task.merged = false;
  task.feedback = undefined;
  task.pipelinePhase = undefined;
  task.auditRetries = 0;
  task.tokensIn = undefined;
  task.tokensOut = undefined;
  task.cacheReadIn = undefined;
  task.cacheWriteIn = undefined;
  task.costUsd = undefined;
  task.durationMs = undefined;
  if (task.metadata?.lastReviewIssues) {
    const { lastReviewIssues: _, ...rest } = task.metadata;
    task.metadata = Object.keys(rest).length ? rest : undefined;
  }
  ctx.deps.taskEventRepo.clearByTask(taskId);
  ctx.clearCheckInState(taskId);
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Reset and start task: ${ctx.getTaskLabel(state, task.id)} - ${task.description}`, 'warning');
  if (state.status === 'running') await ctx.reviewAndDispatch(state);
  return true;
}

/**
 * 从失败任务触发重规划
 */
export async function replanFromTask(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'failed') return false;

  await ctx.notifyGoal(state,
    `Triggering replan from task ${ctx.getTaskLabel(state, task.id)}...`,
    'info',
  );

  // 跳过失败任务
  task.status = 'skipped';
  await ctx.saveState(state);

  await ctx.triggerReplan(state, taskId, {
    type: 'replan',
    reason: `User requested replan after task ${task.id} failed: ${task.error ?? 'unknown error'}`,
  });

  const refreshed = await ctx.getState(goalId);
  if (refreshed?.status === 'running') await ctx.reviewAndDispatch(refreshed, taskId);
  return true;
}

export async function pauseTask(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'running') return false;

  // 中止运行中的 Claude 进程（保留队列，但任务暂停后不需要队列）
  if (task.channelId) {
    const guildId = ctx.getGuildId();
    if (guildId) {
      const lockKey = StateManager.channelLockKey(guildId, task.channelId);
      ctx.deps.claudeClient.abort(lockKey);
    }
  }

  task.status = 'paused';
  // 保留 branchName, threadId, dispatchedAt — 恢复时复用
  await ctx.saveState(state);
  await ctx.notifyGoal(state,
    `Paused task: ${ctx.getTaskLabel(state, task.id)} - ${task.description}\nBranch/thread preserved for resume.`,
    'warning'
  );
  return true;
}

/**
 * 轻推任务：向已有 channel 发送简短提示，让 agent 自行判断状态并继续
 *
 * 各状态处理策略：
 *   failed / paused / blocked_feedback / dispatched（有 channel）→ 状态改 running，发轻推
 *   running（有 channel）→ 不改状态，直接发轻推
 *   completed & !merged（有 channel）→ 不改状态，发轻推提示重新上报
 *   completed & merged               → 仅通知 goal channel，无需操作
 *   无 channel 的非 running 任务     → 重置为 pending，触发重新派发
 */
export async function nudgeTask(ctx: GoalOrchestrator, goalId: string, taskId: string): Promise<{ ok: boolean; message: string }> {
  const state = await ctx.getState(goalId);
  if (!state) return { ok: false, message: 'Goal not found' };

  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return { ok: false, message: 'Task not found' };

  const guildId = ctx.getGuildId();
  if (!guildId) return { ok: false, message: 'Bot not authorized' };

  const label = ctx.getTaskLabel(state, task.id);

  // 已完成且已合并 → 无需操作，仅通知 goal channel
  if (task.status === 'completed' && task.merged) {
    await ctx.notifyGoal(state,
      `Nudge: ${label} - ${task.description} 已完成且已合并，无需操作。`,
      'info'
    );
    return { ok: true, message: 'Already completed and merged' };
  }

  const nudgePrompt = buildNudgePrompt(task, label);

  // 有 channel → 改状态后发轻推
  if (task.channelId) {
    const channelId = task.channelId;
    const prevStatus = task.status;
    const needsStatusChange = ['failed', 'paused', 'blocked_feedback', 'dispatched'].includes(task.status);

    // running 任务：先 abort 当前进程，再轻推，防止并发执行器竞争
    if (task.status === 'running') {
      const lockKey = StateManager.channelLockKey(guildId, channelId);
      ctx.deps.claudeClient.abort(lockKey);
    }

    if (needsStatusChange) {
      task.status = 'running';
      task.error = undefined;
      await ctx.saveState(state);
    }

    await ctx.notifyGoal(state,
      `Nudge: ${label} (${prevStatus}${needsStatusChange ? ' → running' : ''}) - ${task.description}`,
      'info'
    );
    ctx.executeTaskInBackground(goalId, taskId, guildId, channelId, nudgePrompt);
    return { ok: true, message: `Nudged task ${label} (prev: ${prevStatus})` };
  }

  // completed & !merged & 无 channel → 通知 goal channel，无法轻推
  if (task.status === 'completed' && !task.merged) {
    await ctx.notifyGoal(state,
      `Nudge: ${label} - 已完成但无 channel 可推，请人工检查分支 \`${task.branchName ?? '未知'}\` 并触发合并。`,
      'warning'
    );
    return { ok: true, message: `Notified goal channel: ${label} completed but no channel` };
  }

  // 无 channel + 可重派状态 → 重置为 pending，重新派发
  const redispatchable = ['failed', 'paused', 'blocked_feedback'].includes(task.status);
  if (redispatchable) {
    task.status = 'pending';
    task.branchName = undefined;
    task.channelId = undefined;
    task.dispatchedAt = undefined;
    task.error = undefined;
    await ctx.saveState(state);
    await ctx.notifyGoal(state,
      `Nudge: ${label} - ${task.description}（无 channel，重新派发）`,
      'info'
    );
    if (state.status === 'running') await ctx.dispatchNext(state);
    return { ok: true, message: `Re-dispatching task ${label}` };
  }

  return { ok: false, message: `Cannot nudge task in status: ${task.status}` };
}

export function buildNudgePrompt(task: GoalTask, label: string): string {
  if (task.status === 'completed' && !task.merged) {
    return `[Nudge] 任务 ${label} 已标记完成但尚未合并。如工作确实已完成，请重新发送 task.completed 事件触发合并；如还有未完成工作，请继续开发后再上报。`;
  }
  const errorHint = task.error ? `\n上次错误：${task.error}` : '';
  return `[Nudge] 任务 ${label}（先前状态：${task.status}）${errorHint}

请自行评估工作区现有进度，判断下一步：
- 仍有未完成工作 → 继续开发
- 工作已全部完成 → 发送 task.completed 事件
- 遇到无法解决的问题 → 发送 task.feedback 事件说明原因`;
}
