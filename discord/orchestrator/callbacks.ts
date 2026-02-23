/**
 * Task completion / failure callbacks
 *
 * Extracted from GoalOrchestrator.onTaskCompleted / onTaskFailed.
 * Called when a sub-task finishes (success or error) to update state,
 * handle feedback, merge branches, and trigger the next dispatch cycle.
 */

import type { ChatUsageResult } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { buildTaskFailedButtons } from './goal-buttons.js';

export async function onTaskCompleted(
  ctx: GoalOrchestrator,
  goalId: string,
  taskId: string,
  usage?: ChatUsageResult,
): Promise<void> {
  await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    // 防止扫描器与正常流竞争时重复处理同一任务
    if (task.status !== 'running') return;

    // 清除 check-in 追踪
    ctx.clearCheckInState(taskId);

    // 写入 usage 数据
    if (usage) {
      task.tokensIn = usage.input_tokens;
      task.tokensOut = usage.output_tokens;
      task.cacheReadIn = usage.cache_read_input_tokens;
      task.cacheWriteIn = usage.cache_creation_input_tokens;
      task.costUsd = usage.total_cost_usd;
      task.durationMs = usage.duration_ms;
    }

    // 检测 task.feedback 事件（Claude 通过 bot_task_event 写入 DB）
    const feedback = await ctx.checkFeedbackFile(state, task);
    if (feedback) {
      task.feedback = feedback;

      // replan 类型的 feedback → 自动触发重规划 + 分级自治
      if (feedback.type === 'replan') {
        task.status = 'completed';
        task.completedAt = Date.now();
        await ctx.saveState(state);

        await ctx.notifyGoal(state,
          `**Replan feedback:** ${ctx.getTaskLabel(state, task.id)} - ${task.description}\n` +
          `Reason: ${feedback.reason}`,
          'info'
        );

        // 先 merge 分支，再 replan（replan 需要基于已合并的代码状态）
        if (task.branchName) await ctx.mergeAndCleanup(state, task);

        // 触发重规划 + 分级自治
        await ctx.triggerReplan(state, task.id, feedback);

        // replan 后刷新 state 再继续调度
        const refreshed = await ctx.getState(goalId);
        if (refreshed && refreshed.status === 'running') await ctx.reviewAndDispatch(refreshed, taskId);
        return;
      }

      // 非 replan 类型 → 标记为 blocked_feedback 等待人工处理
      task.status = 'blocked_feedback';
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `**Feedback received:** ${ctx.getTaskLabel(state, task.id)} - ${task.description}\n` +
        `Type: ${feedback.type}\n` +
        `Reason: ${feedback.reason}` +
        (feedback.details ? `\nDetails: ${feedback.details}` : ''),
        'warning'
      );
      // blocked_feedback 后也经过审查层，让 reviewAndDispatch 处理路由
      if (state.status === 'running') await ctx.reviewAndDispatch(state);
      return;
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    await ctx.saveState(state);

    const costInfo = usage ? ` ($${usage.total_cost_usd.toFixed(4)}, ${Math.round(usage.duration_ms / 1000)}s)` : '';
    await ctx.notifyGoal(state, `Completed: ${ctx.getTaskLabel(state, task.id)} - ${task.description}${costInfo}`, 'success');

    // Phase Review: 不立即 merge，先触发 per-task 审核
    const guildId = ctx.getGuildId();
    if (guildId && task.branchName) {
      ctx.triggerTaskReview(state, task, guildId);
    } else {
      // 无分支（调研等）→ 直接 merge/dispatch
      if (task.branchName) await ctx.mergeAndCleanup(state, task);
      const refreshed = await ctx.getState(goalId);
      if (refreshed && refreshed.status === 'running') await ctx.reviewAndDispatch(refreshed, taskId);
    }
  });
}

export async function onTaskFailed(
  ctx: GoalOrchestrator,
  goalId: string,
  taskId: string,
  error: string,
  usage?: ChatUsageResult,
): Promise<void> {
  await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    // 清除 check-in 追踪
    ctx.clearCheckInState(taskId);

    task.status = 'failed';
    task.error = error;

    // 写入 usage 数据（失败的 task 也记录已消耗的 token）
    if (usage) {
      task.tokensIn = usage.input_tokens;
      task.tokensOut = usage.output_tokens;
      task.cacheReadIn = usage.cache_read_input_tokens;
      task.cacheWriteIn = usage.cache_creation_input_tokens;
      task.costUsd = usage.total_cost_usd;
      task.durationMs = usage.duration_ms;
    }

    await ctx.saveState(state);

    const costInfo = usage ? ` ($${usage.total_cost_usd.toFixed(4)})` : '';
    const hasContext = !!task.channelId;

    const hint = hasContext
      ? `Reply "retry ${task.id}" to restart, or "refix ${task.id}" to fix in-place.`
      : `Reply "retry ${task.id}" to retry.`;
    const buttons = hasContext
      ? buildTaskFailedButtons(goalId, task.id)
      : undefined;
    await ctx.notifyGoal(state,
      `Failed: ${ctx.getTaskLabel(state, task.id)} - ${task.description}${costInfo}\nError: ${error}\n\n${hint}`,
      'error',
      buttons ? { components: buttons } : undefined,
    );
    if (state.status === 'running') await ctx.reviewAndDispatch(state);
  });
}
