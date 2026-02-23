/**
 * Feedback 调查处理器
 *
 * 从 GoalOrchestrator 提取的 feedback investigation 逻辑。
 * 当子任务进入 blocked_feedback 状态时，自动启动 AI 调查，
 * 根据调查结论决定 continue / retry / replan / escalate。
 */

import type { GoalDriveState, GoalTask } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { logger } from '../utils/logger.js';

/**
 * 启动 feedback 调查流程（fire-and-forget async）
 */
export function startFeedbackInvestigation(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  task: GoalTask,
  guildId: string,
): void {
  const goalId = state.goalId;
  const taskId = task.id;
  const channelId = task.channelId!;

  (async () => {
    try {
      // 使用 Sonnet 做调查（快速且够用）
      const { pipelineSonnetModel: sonnetModel } = ctx.deps.config;
      ctx.switchSessionModel(guildId, channelId, sonnetModel, 'execute');
      await ctx.updatePipelinePhase(goalId, taskId, 'execute');

      await ctx.notifyGoal(state,
        `[GoalOrchestrator] ${taskId}: AI 调查 blocked feedback...`,
        'pipeline',
      );

      const prompt = buildFeedbackInvestigationPrompt(ctx, task, state);
      logger.info(`[Orchestrator] Pipeline ${taskId}: feedback investigation started`);
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, channelId, prompt);

      // 读取调查结论
      const conclusion = await readInvestigationResult(ctx, state, task);
      logger.info(`[Orchestrator] Pipeline ${taskId}: investigation conclusion = ${conclusion.action}`);

      if (!await ctx.isTaskStillRunning(goalId, taskId)) return;

      switch (conclusion.action) {
        case 'continue':
          // Claude 已在调查中修复了问题 → 走 audit → fix 循环验证
          await ctx.notifyGoal(state,
            `[GoalOrchestrator] ${taskId}: 调查结论 — 问题已修复，继续执行`,
            'info',
            { logOnly: true },
          );
          // 调查中已修复 → 重新执行 pipeline 让 Claude 确认并上报完成
          ctx.executeTaskPipeline(goalId, taskId, guildId, channelId, task, state);
          break;

        case 'retry':
          // 需要完全重试
          await ctx.notifyGoal(state,
            `[GoalOrchestrator] ${taskId}: 调查结论 — 需要完全重试\n原因: ${conclusion.reason}`,
            'warning',
            { logOnly: true },
          );
          await ctx.withStateLock(goalId, async () => {
            const freshState = await ctx.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            // retryTask 要求 failed 状态，先改回 failed 再调用
            freshTask.status = 'failed';
            await ctx.saveState(freshState);
          });
          await ctx.retryTask(goalId, taskId);
          break;

        case 'replan': {
          // 需要重新规划
          await ctx.notifyGoal(state,
            `[GoalOrchestrator] ${taskId}: 调查结论 — 需要重新规划\n原因: ${conclusion.reason}`,
            'info',
            { logOnly: true },
          );
          // 最小化持锁范围：只做状态变更，triggerReplan（长耗时）在锁外执行
          let replanState: GoalDriveState | null = null;
          await ctx.withStateLock(goalId, async () => {
            const freshState = await ctx.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            freshTask.status = 'completed';
            freshTask.completedAt = Date.now();
            await ctx.saveState(freshState);
            replanState = freshState;
          });
          if (replanState) {
            await ctx.triggerReplan(replanState, taskId, {
              type: 'replan',
              reason: conclusion.reason,
              details: conclusion.details,
            });
            const refreshed = await ctx.getState(goalId);
            if (refreshed && refreshed.status === 'running') {
              await ctx.reviewAndDispatch(refreshed, taskId);
            }
          }
          break;
        }

        case 'escalate':
        default:
          // 无法自动解决，交给用户
          await ctx.withStateLock(goalId, async () => {
            const freshState = await ctx.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            freshTask.status = 'blocked_feedback';
            freshTask.pipelinePhase = undefined;
            await ctx.saveState(freshState);
            await ctx.notifyGoal(freshState,
              `[GoalOrchestrator] ${taskId}: AI 调查无法自动解决\n原因: ${conclusion.reason}\n需要人工干预。`,
              'error',
              { logOnly: true },
            );
          });
          break;
      }
    } catch (err: any) {
      const stillRunning = await ctx.isTaskStillRunning(goalId, taskId);
      if (!stillRunning) return;
      logger.error(`[Orchestrator] Feedback investigation failed for ${taskId}:`, err);
      // 调查本身失败 → 回到 blocked_feedback 等用户处理
      try {
        await ctx.withStateLock(goalId, async () => {
          const freshState = await ctx.getState(goalId);
          if (!freshState) return;
          const freshTask = freshState.tasks.find(t => t.id === taskId);
          if (!freshTask) return;
          freshTask.status = 'blocked_feedback';
          freshTask.pipelinePhase = undefined;
          await ctx.saveState(freshState);
          await ctx.notifyGoal(freshState,
            `[GoalOrchestrator] ${taskId}: AI 调查出错: ${err.message}\n已回退到 blocked_feedback，需要人工干预。`,
            'error',
            { logOnly: true },
          );
        });
      } catch (cbErr: any) {
        logger.error(`[Orchestrator] startFeedbackInvestigation cleanup also failed:`, cbErr);
      }
    }
  })();
}

/**
 * 构建 feedback 调查 prompt
 */
export function buildFeedbackInvestigationPrompt(
  ctx: GoalOrchestrator,
  task: GoalTask,
  state: GoalDriveState,
): string {
  const fb = task.feedback!;
  const label = ctx.getTaskLabel(state, task.id);

  return ctx.deps.promptService.render('orchestrator.feedback_investigation', {
    TASK_LABEL: label,
    TASK_DESCRIPTION: task.description,
    GOAL_BRANCH: state.goalBranch,
    FEEDBACK_TYPE: fb.type,
    FEEDBACK_REASON: fb.reason,
    FEEDBACK_DETAILS: fb.details ? `Details: ${fb.details}` : '',
    TASK_ID: task.id,
  });
}

/**
 * 读取调查结论事件 task.feedback
 */
export async function readInvestigationResult(
  ctx: GoalOrchestrator,
  _state: GoalDriveState,
  task: GoalTask,
): Promise<{ action: string; reason: string; details?: string }> {
  const defaultResult = { action: 'escalate', reason: 'No investigation event found in DB' };

  const result = ctx.deps.taskEventRepo.read<{ action: string; reason: string; details?: string }>(
    task.id, 'task.feedback',
  );
  if (!result) return defaultResult;

  const validActions = ['continue', 'retry', 'replan', 'escalate'];
  return {
    action: validActions.includes(result.action) ? result.action : 'escalate',
    reason: result.reason || 'No reason provided',
    details: result.details,
  };
}
