/**
 * Replan handler — extracted from GoalOrchestrator
 *
 * Contains: triggerReplan, approveReplan, getPendingReplanChangesJson,
 *           approveReplanWithModifications, rejectReplan
 */

import type { GoalOrchestrator } from './index.js';
import type { GoalDriveState, GoalTaskFeedback } from '../types/index.js';
import { logger } from '../utils/logger.js';
import {
  buildReplanPrompt,
  collectCompletedDiffStats,
  handleReplanByImpact,
  applyChanges,
  type ReplanContext,
  type ReplanChange,
  type ReplanResult,
} from './replanner.js';
import { buildReplanRollbackButton } from './goal-buttons.js';

export async function triggerReplan(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  triggerTaskId: string,
  feedback: GoalTaskFeedback,
): Promise<void> {
  const guildId = ctx.getGuildId();
  if (!guildId) {
    logger.warn('[Orchestrator] triggerReplan: no guildId, skipping');
    return;
  }

  try {
    // 1. 收集 diff stats
    const completedDiffStats = await collectCompletedDiffStats(state);

    // 2. 获取 Goal 元数据
    const goalMeta = await ctx.deps.goalMetaRepo.get(state.goalId);

    // 3. 构建 prompt 并发送给 reviewer session
    const replanCtx: ReplanContext = {
      state,
      goalMeta,
      triggerTaskId,
      feedback,
      completedDiffStats,
      promptService: ctx.deps.promptService,
    };
    const replanPrompt = buildReplanPrompt(replanCtx);

    ctx.ensureGoalChannelSession(state, guildId);
    const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;

    logger.info(`[Orchestrator] triggerReplan: sending to reviewer channel ${reviewerChannelId}`);
    await ctx.deps.messageHandler.handleBackgroundChat(guildId, reviewerChannelId, replanPrompt);

    // 4. 内联读取 replan.result 事件（reviewer session 结束后写入）
    const raw = ctx.deps.taskEventRepo.read<ReplanResult>(triggerTaskId, 'replan.result');
    if (!raw || !Array.isArray(raw.changes) || typeof raw.reasoning !== 'string') {
      logger.warn(`[Orchestrator] triggerReplan: missing or invalid replan.result event for task ${triggerTaskId}`);
      await ctx.notifyGoal(state,
        `Replan 跳过 — Reviewer 未返回有效结果，当前计划保持不变`,
        'warning',
      );
      return;
    }
    const result: ReplanResult = raw;

    // 标记已处理，防止 scanner 重复处理
    ctx.deps.taskEventRepo.markProcessedByTask(triggerTaskId, 'replan.result');

    if (result.changes.length === 0) {
      await ctx.notifyGoal(state,
        `Replan: 无需变更 — ${result.reasoning || '（无说明）'}`,
        'info',
      );
      return;
    }

    // 5. 分级自治处理
    const handleResult = await handleReplanByImpact(state, result, {
      taskRepo: ctx.deps.taskRepo,
      goalMetaRepo: ctx.deps.goalMetaRepo,
      checkpointRepo: ctx.deps.checkpointRepo,
      notify: (threadId, message, type, options) => ctx.notify(threadId, message, type, options),
    });

    if (handleResult.autoApplied) {
      logger.info(
        `[Orchestrator] Replan auto-applied (${handleResult.impactLevel}), goal ${state.goalId}`,
      );
    } else {
      logger.info(
        `[Orchestrator] Replan pending approval (high impact), goal ${state.goalId}`,
      );
    }
  } catch (err: any) {
    logger.error('[Orchestrator] triggerReplan failed:', err);
    await ctx.notifyGoal(state,
      `Replan 失败: ${err.message}`,
      'error',
    );
  }
}

/**
 * 用户审批 replan（approve replan）
 * 从 state.pendingReplan 读取待审批的变更并应用
 */
export async function approveReplan(ctx: GoalOrchestrator, goalId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;

  if (!state.pendingReplan) {
    await ctx.notifyGoal(state, '没有待审批的计划变更', 'info');
    return false;
  }

  const pending = state.pendingReplan;

  // 应用变更
  const applyResult = await applyChanges(state, pending.changes as ReplanChange[], {
    taskRepo: ctx.deps.taskRepo,
    goalMetaRepo: ctx.deps.goalMetaRepo,
  });

  // 清除 pending 状态
  delete state.pendingReplan;
  await ctx.saveState(state);

  await ctx.notifyGoal(state,
    `✅ **计划变更已批准并执行**\n` +
    `已应用 ${applyResult.applied.length} 项变更` +
    (applyResult.rejected.length > 0
      ? `，${applyResult.rejected.length} 项被拒绝`
      : '') +
    `\n快照 ID: \`${pending.checkpointId}\``,
    'success',
    { components: buildReplanRollbackButton(goalId, pending.checkpointId) },
  );

  // 恢复调度（经过审查层，replan 后可能引入新占位任务）
  if (state.status === 'running') {
    await ctx.reviewAndDispatch(state);
  }

  return true;
}

/**
 * 获取待审批 replan 变更的 JSON 文本（用于预填 Modal）
 */
export async function getPendingReplanChangesJson(ctx: GoalOrchestrator, goalId: string): Promise<string | null> {
  const state = await ctx.getState(goalId);
  if (!state?.pendingReplan) return null;
  return JSON.stringify(state.pendingReplan.changes, null, 2);
}

/**
 * 用户修改后批准 replan（approve with modifications）
 * 解析用户修改后的变更 JSON 并应用
 */
export async function approveReplanWithModifications(
  ctx: GoalOrchestrator,
  goalId: string,
  modifiedChangesJson: string,
): Promise<{ success: boolean; applied: number; rejected: number; error?: string }> {
  const state = await ctx.getState(goalId);
  if (!state) return { success: false, applied: 0, rejected: 0, error: 'Goal not found' };

  if (!state.pendingReplan) {
    return { success: false, applied: 0, rejected: 0, error: '没有待审批的计划变更' };
  }

  // 解析用户修改后的 JSON
  let modifiedChanges: ReplanChange[];
  try {
    const parsed = JSON.parse(modifiedChangesJson);
    if (!Array.isArray(parsed)) {
      return { success: false, applied: 0, rejected: 0, error: 'JSON 必须是数组格式' };
    }
    modifiedChanges = parsed;
  } catch (err: any) {
    return { success: false, applied: 0, rejected: 0, error: `JSON 解析失败: ${err.message}` };
  }

  const pending = state.pendingReplan;

  // 应用修改后的变更
  const applyResult = await applyChanges(state, modifiedChanges, {
    taskRepo: ctx.deps.taskRepo,
    goalMetaRepo: ctx.deps.goalMetaRepo,
  });

  // 清除 pending 状态
  delete state.pendingReplan;
  await ctx.saveState(state);

  await ctx.notifyGoal(state,
    `✅ **修改后的计划已批准并执行**\n` +
    `已应用 ${applyResult.applied.length} 项变更` +
    (applyResult.rejected.length > 0
      ? `，${applyResult.rejected.length} 项被拒绝`
      : '') +
    `\n快照 ID: \`${pending.checkpointId}\``,
    'success',
    { components: buildReplanRollbackButton(goalId, pending.checkpointId) },
  );

  // 恢复调度
  if (state.status === 'running') {
    await ctx.reviewAndDispatch(state);
  }

  return {
    success: true,
    applied: applyResult.applied.length,
    rejected: applyResult.rejected.length,
  };
}

/**
 * 用户拒绝 replan（reject replan）
 * 丢弃待审批的变更，恢复调度
 */
export async function rejectReplan(ctx: GoalOrchestrator, goalId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state) return false;

  const pending = state.pendingReplan;
  if (!pending) {
    await ctx.notifyGoal(state, '没有待审批的计划变更', 'info');
    return false;
  }

  // 清除 pending 状态
  delete state.pendingReplan;
  await ctx.saveState(state);

  await ctx.notifyGoal(state,
    `🚫 **计划变更已拒绝**\n快照 ID: \`${pending.checkpointId}\``,
    'info',
  );

  // 恢复调度
  if (state.status === 'running') {
    await ctx.reviewAndDispatch(state);
  }

  return true;
}
