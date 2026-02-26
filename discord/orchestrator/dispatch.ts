/**
 * Dispatch / scheduling methods extracted from GoalOrchestrator.
 *
 * Responsible for reviewing completed tasks, determining next batch,
 * creating worktrees + Discord channels, and launching the execution pipeline.
 */

import { ChannelType, EmbedBuilder } from 'discord.js';
import { StateManager } from '../bot/state.js';
import { EmbedColors } from '../bot/message-queue.js';
import type { GoalDriveState, GoalTask } from '../types/index.js';
import { ClaudeErrorType, ClaudeExecutionError } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { logger } from '../utils/logger.js';
import { execGit } from './git-ops.js';
import { createSubtaskBranch } from './goal-branch.js';
import { generateTopicTitle } from '../utils/llm.js';
import {
  getNextBatch,
  isGoalComplete,
  isGoalStuck,
  getProgressSummary,
  getPhaseNumber,
  isPhaseFullyMerged,
} from './task-scheduler.js';
import { triggerGoalAudit } from './goal-audit-handler.js';

/**
 * Review completed task results and decide what to dispatch next.
 *
 * Runs three review passes before falling through to normal dispatch:
 *   1. Placeholder task interception (trigger replan when deps are met)
 *   2. Deep review of research tasks that didn't submit replan feedback
 *   3. Feedback routing for blocked_feedback tasks
 */
export async function reviewAndDispatch(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  completedTaskId?: string,
): Promise<void> {
  if (state.status !== 'running') return;

  // ── 审查 1: 占位任务拦截 ──
  // 查看待分发队列中是否有占位任务变为可达状态（前一阶段已完成）
  const pendingPlaceholders = state.tasks.filter(t => {
    if (t.status !== 'pending' || t.type !== '占位') return false;
    const phase = getPhaseNumber(t);
    return phase <= 1 || isPhaseFullyMerged(state, phase - 1);
  });
  if (pendingPlaceholders.length > 0) {
    const placeholderIds = pendingPlaceholders.map(t => t.id).join(', ');
    logger.info(`[Orchestrator] Placeholder tasks ready: ${placeholderIds} — forcing replan`);
    await ctx.notifyGoal(state,
      `**占位任务触发重规划:** ${placeholderIds}\n` +
      `占位任务的依赖已满足，需要重新规划将其替换为具体任务。`,
      'info',
    );

    // 用第一个占位任务触发 replan
    const trigger = pendingPlaceholders[0];
    await ctx.triggerReplan(state, trigger.id, {
      type: 'replan',
      reason: `占位任务 ${placeholderIds} 的依赖已满足，需要将占位任务替换为具体可执行任务`,
      details: `placeholder_ids: ${placeholderIds}`,
    });

    // replan 后刷新 state 再继续调度（replan 可能改变了任务图）
    const refreshed = await ctx.getState(state.goalId);
    if (refreshed && refreshed.status === 'running') {
      await dispatchNext(ctx, refreshed);
    }
    return;
  }

  // ── 审查 2: 调研任务深度审查 ──
  // 刚完成的调研任务如果没有写 replan feedback，主动触发深度审查
  if (completedTaskId) {
    const completedTask = state.tasks.find(t => t.id === completedTaskId);
    if (
      completedTask &&
      completedTask.type === '调研' &&
      completedTask.status === 'completed' &&
      (!completedTask.feedback || completedTask.feedback.type !== 'replan')
    ) {
      logger.info(
        `[Orchestrator] Research task ${completedTaskId} completed without replan feedback — triggering deep review`,
      );
      await ctx.notifyGoal(state,
        `**调研任务深度审查:** ${completedTask.id} - ${completedTask.description}\n` +
        `调研任务完成但未提交 replan feedback，自动触发深度审查。`,
        'info',
      );

      await ctx.triggerReplan(state, completedTask.id, {
        type: 'replan',
        reason: `调研任务 ${completedTask.id} 已完成，自动触发深度审查以评估调研结果对后续任务的影响`,
      });

      const refreshed = await ctx.getState(state.goalId);
      if (refreshed && refreshed.status === 'running') {
        await dispatchNext(ctx, refreshed);
      }
      return;
    }
  }

  // ── 审查 3: Feedback 待处理任务路由 ──
  // 检查是否有 blocked_feedback 状态的任务需要按 type 路由处理
  const feedbackTasks = state.tasks.filter(t => t.status === 'blocked_feedback' && t.feedback);
  for (const task of feedbackTasks) {
    const fb = task.feedback!;
    switch (fb.type) {
      case 'blocked':
      case 'clarify': {
        // blocked/clarify：如果有 thread 上下文，启动 AI 调查
        if (task.channelId) {
          const guildId = ctx.getGuildId();
          if (guildId) {
            task.status = 'running';
            task.pipelinePhase = 'execute';
            await ctx.saveState(state);
            ctx.startFeedbackInvestigation(state, task, guildId);
            // 不 return —— 继续处理其他任务，调查异步进行
            continue;
          }
        }
        // 没有 thread 上下文，只能等用户干预
        break;
      }

      case 'replan':
        // replan 类型正常应该在 onTaskCompleted 中已处理
        // 这里作为兜底：如果意外到达此状态，触发 replan
        logger.warn(`[Orchestrator] Unexpected replan feedback in blocked_feedback state: ${task.id}`);
        task.status = 'completed';
        task.completedAt = Date.now();
        await ctx.saveState(state);
        await ctx.triggerReplan(state, task.id, fb);
        const refreshed = await ctx.getState(state.goalId);
        if (refreshed && refreshed.status === 'running') {
          await dispatchNext(ctx, refreshed);
        }
        return;

      default:
        // 未知 feedback 类型：记录日志，不阻塞调度
        logger.warn(`[Orchestrator] Unknown feedback type "${fb.type}" on task ${task.id}`);
        break;
    }
  }

  // ── 审查通过：走正常分发 ──
  await dispatchNext(ctx, state);
}

/**
 * Determine the next batch of tasks and dispatch them.
 *
 * Checks for goal completion / stuck state first, then picks the
 * next eligible batch via `getNextBatch` and dispatches each task.
 */
export async function dispatchNext(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
): Promise<void> {
  if (state.status !== 'running') return;

  if (isGoalComplete(state)) {
    state.status = 'completed';
    await ctx.saveState(state);
    await ctx.syncGoalMeta(state);

    // 检查未完成的 todo
    let todoWarning = '';
    try {
      const unfinished = await ctx.deps.goalTodoRepo.findUndoneByGoal(state.goalId);
      if (unfinished.length > 0) {
        todoWarning = `\n\n**Unfinished todos (${unfinished.length}):**\n` +
          unfinished.map(t => `- ${t.content}`).join('\n');
      }
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to fetch goal todos: ${err.message}`);
    }

    await ctx.notifyGoal(state,
      `**Goal "${state.goalName}" completed!**\n` +
      `Review branch \`${state.goalBranch}\` and merge to main.` +
      todoWarning,
      'success'
    );

    // 自动触发代码审查报告（fire-and-forget）
    const guildIdForAudit = ctx.getGuildId();
    if (guildIdForAudit) {
      triggerGoalAudit(ctx, state, guildIdForAudit);
    }

    return;
  }

  if (isGoalStuck(state)) {
    await ctx.syncGoalMeta(state);
    await ctx.notifyGoal(state,
      `Goal "${state.goalName}" is stuck\n` +
      `May have unresolved dependencies or failed tasks\n` +
      `Progress: ${getProgressSummary(state)}`,
      'warning'
    );
    return;
  }

  const batch = getNextBatch(state);

  const blockedTasks = state.tasks.filter(t => t.status === 'blocked');
  for (const task of blockedTasks) {
    if (!task.notifiedBlocked) {
      task.notifiedBlocked = true;
      await ctx.notifyGoal(state,
        `Manual task pending: ${ctx.getTaskLabel(state, task.id)} - ${task.description}\nReply "done ${task.id}" when complete.`,
        'warning'
      );
    }
  }

  await ctx.saveState(state);

  for (const task of batch) {
    await dispatchTask(ctx, state, task);
  }

  // dispatch 后同步 Goal 元数据，确保 next 反映新启动的任务
  await ctx.syncGoalMeta(state);
}

/**
 * Dispatch a single task: create branch, worktree, Discord channel,
 * and kick off the execution pipeline.
 */
export async function dispatchTask(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  task: GoalTask,
): Promise<void> {
  const branchName = await ctx.generateBranchName(task, state);
  task.branchName = branchName;
  task.status = 'dispatched';
  task.dispatchedAt = Date.now();
  await ctx.saveState(state);

  try {
    const stdout = await execGit(
      ['worktree', 'list', '--porcelain'],
      state.baseCwd,
      `dispatchTask(${task.id}): list worktrees`
    );

    const goalWorktreeDir = ctx.findWorktreeDir(stdout, state.goalBranch);
    if (!goalWorktreeDir) {
      throw new Error(`Goal worktree for ${state.goalBranch} not found`);
    }

    const { worktreeDir: subtaskDir, isExisting } = await createSubtaskBranch(
      goalWorktreeDir,
      branchName,
      ctx.deps.config.worktreesDir
    );

    const guildId = ctx.getGuildId();
    if (!guildId) throw new Error('Bot not authorized');

    const taskLabel = ctx.getTaskLabel(state, task.id);

    // 分支已存在且 task 持有 channelId → 直接 resume，跳过创建 channel
    if (isExisting && task.channelId) {
      const channelId = task.channelId;
      task.status = 'running';
      await ctx.saveState(state);

      // 确保 session 存在（bot 重启后可能丢失）
      ctx.deps.stateManager.getOrCreateSession(guildId, channelId, {
        name: taskLabel,
        cwd: subtaskDir,
      });
      ctx.deps.stateManager.setSessionForkInfo(guildId, channelId, state.goalChannelId, branchName);

      await ctx.notifyGoal(state,
        `Resumed (branch existed): ${taskLabel} - ${task.description} → \`${branchName}\``,
        'info'
      );
      // 用轻量 continuation prompt 而非完整 buildTaskPrompt，
      // 避免向已有 channel 重复发送初始任务描述
      ctx.executeTaskInBackground(
        state.goalId, task.id, guildId, channelId,
        `[Resumed] 分支 \`${branchName}\` 已存在，请检查工作区现有进度并继续完成任务。`
      );
      return;
    }

    const categoryId = await ctx.findCategoryId(state.goalChannelId);

    if (!categoryId) {
      throw new Error('Cannot find Category for goal channel');
    }

    const guild = await ctx.deps.client.guilds.fetch(guildId);
    const title = await generateTopicTitle(task.description);
    const channelName = `${taskLabel} ${title}`.slice(0, 100);

    const textChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      reason: `Goal subtask: ${taskLabel}`,
    });

    // 发送初始消息
    const initEmbed = new EmbedBuilder()
      .setColor(EmbedColors.PURPLE)
      .setDescription(`[goal] Task: \`${taskLabel}\` - ${task.description}\nBranch: \`${branchName}\`\nWorking directory: \`${subtaskDir}\``.slice(0, 4096));
    await textChannel.send({ embeds: [initEmbed] });

    const newThreadId = textChannel.id;

    ctx.deps.stateManager.getOrCreateSession(guildId, newThreadId, {
      name: channelName,
      cwd: subtaskDir,
    });
    ctx.deps.stateManager.setSessionForkInfo(guildId, newThreadId, state.goalChannelId, branchName);

    task.channelId = newThreadId;
    task.status = 'running';
    await ctx.saveState(state);

    const dispatchMsg = isExisting
      ? `Resumed (branch existed, new channel): ${taskLabel} - ${task.description} → \`${branchName}\``
      : `Dispatched: ${taskLabel} - ${task.description} → \`${branchName}\``;
    await ctx.notifyGoal(state, dispatchMsg, 'info');

    executeTaskPipeline(ctx, state.goalId, task.id, guildId, newThreadId, task, state);

  } catch (err: any) {
    task.status = 'failed';
    task.error = err.message;
    await ctx.saveState(state);
    await ctx.notifyGoal(state,
      `Dispatch failed: ${ctx.getTaskLabel(state, task.id)} - ${task.description}\nError: ${err.message}`,
      'error'
    );
  }
}

/**
 * Fire-and-forget execution pipeline for a dispatched task.
 *
 * Selects the model (Opus for research, Sonnet otherwise), sends the
 * task prompt to Claude, and handles completion / failure callbacks.
 */
export function executeTaskPipeline(
  ctx: GoalOrchestrator,
  goalId: string,
  taskId: string,
  guildId: string,
  channelId: string,
  task: GoalTask,
  state: GoalDriveState,
): void {
  const usage = ctx.emptyUsage();
  (async () => {
    try {
      // 统一 pipeline：单次执行，Claude 自驱动
      const model = task.type === '调研'
        ? ctx.deps.config.pipelineOpusModel
        : ctx.deps.config.pipelineSonnetModel;
      ctx.switchSessionModel(guildId, channelId, model, 'execute');
      await ctx.updatePipelinePhase(goalId, taskId, 'execute');

      await ctx.notifyGoal(state,
        `[GoalOrchestrator] ${taskId}: ${task.type === '调研' ? 'Opus' : 'Sonnet'} 执行`,
        'pipeline',
      );

      const taskPrompt = ctx.buildTaskPrompt(task, state);
      logger.info(`[Orchestrator] Pipeline ${taskId}: ${task.type} → single execute`);
      const u = await ctx.deps.messageHandler.handleBackgroundChat(guildId, channelId, taskPrompt, 'orchestrator');
      ctx.accumulateUsage(usage, u);

      if (!await ctx.isTaskStillRunning(goalId, taskId)) {
        logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running after execute, aborting`);
        return;
      }

      // Claude 应已通过 bot_task_event 上报 task.completed 或 task.feedback
      // 事件扫描器会处理，这里作为 fallback 直接调用
      await ctx.onTaskCompleted(goalId, taskId, usage);
    } catch (err: any) {
      // AUTH_ERROR / API_ERROR：拦截器已调度自动重试，task 保持 running 等待 Claude 完成后上报 bot_task_event
      // checkOrphanedTasks 会在 session idle 后轻推兜底
      if (err instanceof ClaudeExecutionError && (
        err.errorType === ClaudeErrorType.AUTH_ERROR ||
        err.errorType === ClaudeErrorType.API_ERROR
      )) {
        logger.warn(`[Orchestrator] Pipeline ${taskId} got ${err.errorType}, keeping task running for interceptor retry`);
        return;
      }
      logger.error(`[Orchestrator] Pipeline ${taskId} failed:`, err);
      const stillRunning = await ctx.isTaskStillRunning(goalId, taskId);
      if (!stillRunning) {
        logger.info(`[Orchestrator] Pipeline ${taskId}: task already ${await ctx.getTaskStatus(goalId, taskId)}, skipping onTaskFailed`);
        return;
      }
      try {
        await ctx.onTaskFailed(goalId, taskId, err.message, usage);
      } catch (cbErr: any) {
        logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr);
      }
    }
  })();
}
