/**
 * Feedback 调查处理器
 *
 * 从 GoalOrchestrator 提取的 feedback investigation 逻辑。
 * 当子任务进入 blocked_feedback 状态时，自动启动 AI 调查，
 * 根据调查结论决定 continue / retry / replan / escalate。
 */

import type { GoalDriveState, GoalTask } from '../types/index.js';
import { TaskStatus, PipelinePhase, FeedbackInvestigationAction, GoalDriveStatus } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { NotifyType } from './orchestrator-types.js';
import { logger } from '../utils/logger.js';
import { triggerTechLeadConsultation } from './review-handler.js';
import { TaskEventType } from '../db/repo/task-event-repo.js';

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
      ctx.switchSessionModel(guildId, channelId, sonnetModel, PipelinePhase.Execute);
      await ctx.updatePipelinePhase(goalId, taskId, PipelinePhase.Execute);

      await ctx.notifyGoal(state,
        `[GoalOrchestrator] ${taskId}: AI 调查 blocked feedback...`,
        NotifyType.Pipeline,
      );

      const prompt = buildFeedbackInvestigationPrompt(ctx, task, state);
      logger.info(`[Orchestrator] Pipeline ${taskId}: feedback investigation started`);
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, channelId, prompt, 'feedback');

      // 读取调查结论
      const conclusion = await readInvestigationResult(ctx, state, task);
      logger.info(`[Orchestrator] Pipeline ${taskId}: investigation conclusion = ${conclusion.action}`);

      if (!await ctx.isTaskStillRunning(goalId, taskId)) return;

      switch (conclusion.action) {
        case FeedbackInvestigationAction.Continue:
          // Claude 已在调查中修复了问题 → 走 audit → fix 循环验证
          await ctx.notifyGoal(state,
            `[GoalOrchestrator] ${taskId}: 调查结论 — 问题已修复，继续执行`,
            NotifyType.Info,
            { logOnly: true },
          );
          // 调查中已修复 → 重新执行 pipeline 让 Claude 确认并上报完成
          ctx.executeTaskPipeline(goalId, taskId, guildId, channelId, task, state);
          break;

        case FeedbackInvestigationAction.Retry:
          // 在原 channel 中继续执行（resume 语义），调查结论留在 thread 供参考
          await ctx.notifyGoal(state,
            `[GoalOrchestrator] ${taskId}: 调查结论 — 在原 thread 继续执行\n原因: ${conclusion.reason}`,
            NotifyType.Warning,
            { logOnly: true },
          );
          await ctx.withStateLock(goalId, async () => {
            const freshState = await ctx.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            // 确保 task 处于 retryTask 可接受的状态
            if (![TaskStatus.Failed, TaskStatus.BlockedFeedback, TaskStatus.Paused].includes(freshTask.status)) {
              freshTask.status = TaskStatus.Failed;
              await ctx.saveState(freshState);
            }
          });
          await ctx.retryTask(goalId, taskId);
          break;

        case FeedbackInvestigationAction.Replan: {
          // 调查结论需要修改任务 → 标记完成，通知 tech lead
          await ctx.notifyGoal(state,
            `[GoalOrchestrator] ${taskId}: 调查结论 — 需要修改任务\n原因: ${conclusion.reason}`,
            NotifyType.Info,
            { logOnly: true },
          );
          await ctx.withStateLock(goalId, async () => {
            const freshState = await ctx.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            freshTask.status = TaskStatus.Completed;
            freshTask.completedAt = Date.now();
            await ctx.saveState(freshState);
          });

          const guildId = ctx.getGuildId();
          if (state.techLeadChannelId && guildId) {
            triggerTechLeadConsultation(ctx, state, guildId,
              `调查任务 ${taskId} 结论：需要修改后续任务`,
              `Reason: ${conclusion.reason}${conclusion.details ? `\nDetails: ${conclusion.details}` : ''}`,
            );
          }

          const refreshed = await ctx.getState(goalId);
          if (refreshed && refreshed.status === GoalDriveStatus.Running) {
            await ctx.reviewAndDispatch(refreshed, taskId);
          }
          break;
        }

        case FeedbackInvestigationAction.Escalate:
        default: {
          // AI 调查无法自动解决 → 先让 tech lead 介入
          let escalateState: GoalDriveState | null = null;
          await ctx.withStateLock(goalId, async () => {
            const freshState = await ctx.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            freshTask.status = TaskStatus.BlockedFeedback;
            freshTask.pipelinePhase = undefined;
            await ctx.saveState(freshState);
            escalateState = freshState;
          });
          if (!escalateState) break;
          const guildId = ctx.getGuildId();
          if ((escalateState as GoalDriveState).techLeadChannelId && guildId) {
            triggerTechLeadConsultation(
              ctx,
              escalateState as GoalDriveState,
              guildId,
              `Task ${taskId} is blocked — AI investigation could not resolve it`,
              `Original feedback: ${task.feedback?.type} — ${task.feedback?.reason}\n` +
              `AI investigation conclusion: ${conclusion.reason}`,
            );
            await ctx.notifyGoal(escalateState as GoalDriveState,
              `[GoalOrchestrator] ${taskId}: AI 调查无法自动解决，已上报 tech lead 介入`,
              NotifyType.Warning,
              { logOnly: true },
            );
          } else {
            await ctx.notifyGoal(escalateState as GoalDriveState,
              `[GoalOrchestrator] ${taskId}: AI 调查无法自动解决\n原因: ${conclusion.reason}\n需要人工干预。`,
              NotifyType.Error,
              { logOnly: true },
            );
          }
          break;
        }
      }
    } catch (err: any) {
      const stillRunning = await ctx.isTaskStillRunning(goalId, taskId);
      if (!stillRunning) return;
      logger.error(`[Orchestrator] Feedback investigation failed for ${taskId}:`, err);
      // 调查本身失败 → 先让 tech lead 介入，无 tech lead 则通知用户
      try {
        let errorState: GoalDriveState | null = null;
        await ctx.withStateLock(goalId, async () => {
          const freshState = await ctx.getState(goalId);
          if (!freshState) return;
          const freshTask = freshState.tasks.find(t => t.id === taskId);
          if (!freshTask) return;
          freshTask.status = TaskStatus.BlockedFeedback;
          freshTask.pipelinePhase = undefined;
          await ctx.saveState(freshState);
          errorState = freshState;
        });
        if (!errorState) return;
        const guildId = ctx.getGuildId();
        if ((errorState as GoalDriveState).techLeadChannelId && guildId) {
          triggerTechLeadConsultation(
            ctx,
            errorState as GoalDriveState,
            guildId,
            `Task ${taskId} is blocked — AI investigation itself failed with an error`,
            `Investigation error: ${err.message}`,
          );
          await ctx.notifyGoal(errorState as GoalDriveState,
            `[GoalOrchestrator] ${taskId}: AI 调查出错，已上报 tech lead 介入`,
            NotifyType.Warning,
            { logOnly: true },
          );
        } else {
          await ctx.notifyGoal(errorState as GoalDriveState,
            `[GoalOrchestrator] ${taskId}: AI 调查出错: ${err.message}\n已回退到 blocked_feedback，需要人工干预。`,
            NotifyType.Error,
            { logOnly: true },
          );
        }
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
  const label = task.id;

  return ctx.deps.promptService.render('orchestrator.feedback_investigation', {
    TASK_LABEL: label,
    TASK_DESCRIPTION: task.description,
    GOAL_BRANCH: state.branch,
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
): Promise<{ action: FeedbackInvestigationAction; reason: string; details?: string }> {
  const defaultResult = { action: FeedbackInvestigationAction.Escalate, reason: 'No investigation event found in DB' };

  const result = ctx.deps.taskEventRepo.read<{ action: string; reason: string; details?: string }>(
    task.id, TaskEventType.Feedback,
  );
  if (!result) return defaultResult;

  const validActions = Object.values(FeedbackInvestigationAction);
  return {
    action: validActions.includes(result.action as FeedbackInvestigationAction)
      ? result.action as FeedbackInvestigationAction
      : FeedbackInvestigationAction.Escalate,
    reason: result.reason || 'No reason provided',
    details: result.details,
  };
}
