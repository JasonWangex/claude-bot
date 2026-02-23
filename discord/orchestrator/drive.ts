/**
 * Drive lifecycle methods extracted from GoalOrchestrator.
 *
 * All functions take `ctx: GoalOrchestrator` as the first parameter
 * and delegate to ctx.* for state / notification / dispatch.
 */

import { ChannelType } from 'discord.js';
import { stat } from 'fs/promises';
import { logger } from '../utils/logger.js';
import { execGit, resolveMainWorktree } from './git-ops.js';
import { goalNameToBranch } from './goal-state.js';
import { createGoalBranch } from './goal-branch.js';
import { parseTaskDetailPlans, formatDetailPlanForPrompt } from './goal-body-parser.js';
import { StateManager } from '../bot/state.js';
import type { GoalDriveState, GoalTask } from '../types/index.js';
import type { StartDriveParams } from './orchestrator-types.js';
import type { GoalOrchestrator } from './index.js';

// ── startDrive ──────────────────────────────────────────────────────────

export async function startDrive(ctx: GoalOrchestrator, params: StartDriveParams): Promise<GoalDriveState> {
  const { goalId, goalName, goalChannelId, baseCwd: inputCwd, maxConcurrent = 3 } = params;

  // 已有 drive 时：paused → 自动 resume；running → 直接返回当前状态
  const existing = ctx.activeDrives.get(goalId) || await ctx.deps.goalRepo.get(goalId);
  if (existing) {
    if (existing.status === 'paused') {
      logger.info(`[Orchestrator] Goal "${goalName}" is paused, auto-resuming`);
      await resumeDrive(ctx, goalId);
      return ctx.activeDrives.get(goalId) ?? existing;
    }
    if (existing.status === 'running') {
      await ctx.notify(goalChannelId, `Goal "${goalName}" is already running.`, 'info');
      return existing;
    }
  }

  let baseCwd: string;
  try {
    baseCwd = await resolveMainWorktree(inputCwd);
    if (baseCwd !== inputCwd) {
      logger.info(`[Orchestrator] Normalized baseCwd: ${inputCwd} → ${baseCwd}`);
    }
  } catch (err: any) {
    await ctx.notify(goalChannelId, `Invalid working directory: ${inputCwd}\nError: ${err.message}`, 'error');
    throw err;
  }

  const goalBranch = await goalNameToBranch(goalName);

  let goalWorktreeDir: string;
  try {
    goalWorktreeDir = await createGoalBranch(baseCwd, goalBranch, ctx.deps.config.worktreesDir);
  } catch (err: any) {
    await ctx.notify(goalChannelId, `Failed to create goal branch: ${err.message}`, 'error');
    throw err;
  }

  // 获取 goalMeta（seq + body）
  const goalMeta = await ctx.deps.goalMetaRepo.get(goalId);
  const goalSeq = goalMeta?.seq ?? 0;

  // tasks 由 Claude 提前通过 bot_goal_tasks(action="set") 写入 DB
  const storedTasks = await ctx.deps.taskRepo.getAllByGoal(goalId);
  if (storedTasks.length === 0) {
    const err = new Error(`No tasks found for goal ${goalId}. Use bot_goal_tasks(action="set") to initialize tasks before starting drive.`);
    await ctx.notify(goalChannelId, err.message, 'error');
    throw err;
  }
  logger.info(`[Orchestrator] Loaded ${storedTasks.length} tasks from DB for goal ${goalId}`);

  // 附加详细计划（来自 goal body）
  const plans = goalMeta?.body ? parseTaskDetailPlans(goalMeta.body) : new Map();
  const tasks = storedTasks.map(t => {
    const plan = plans.get(t.id);
    return plan ? { ...t, detailPlan: formatDetailPlanForPrompt(plan) } : t;
  }) as GoalTask[];

  const state: GoalDriveState = {
    goalId,
    goalSeq,
    goalName,
    goalBranch,
    goalChannelId,
    baseCwd,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxConcurrent,
    tasks,
  };

  // 创建审核员专用 channel（与 goal channel 同一 Category 下）
  const guildId = ctx.getGuildId();
  if (guildId) {
    try {
      const categoryId = await ctx.findCategoryId(goalChannelId);
      if (categoryId) {
        const guild = await ctx.deps.client.guilds.fetch(guildId);
        const reviewerChannel = await guild.channels.create({
          name: `g${goalSeq}-reviewer`,
          type: ChannelType.GuildText,
          parent: categoryId,
          reason: `Goal reviewer: ${goalName}`,
        });
        state.reviewerChannelId = reviewerChannel.id;
        logger.info(`[Orchestrator] Created reviewer channel: ${reviewerChannel.id} for goal ${goalId}`);
      } else {
        logger.warn(`[Orchestrator] Cannot find Category for goal channel ${goalChannelId}, reviewer will use goal channel`);
      }
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to create reviewer channel: ${err.message}, falling back to goal channel`);
    }
  }

  await ctx.saveState(state);
  ctx.activeDrives.set(goalId, state);
  await ctx.syncGoalMetaStatus(goalId, 'Processing');

  // 为审核员 channel 创建 Opus 会话并发送初始化 prompt
  if (guildId) {
    ctx.ensureGoalChannelSession(state, guildId);
    const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;
    const initPrompt = ctx.deps.promptService.render('orchestrator.reviewer_init', {
      GOAL_NAME: goalName,
      GOAL_BRANCH: goalBranch,
      GOAL_ID: goalId,
    });
    try {
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, reviewerChannelId, initPrompt);
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to send reviewer init prompt: ${err.message}`);
    }
  }

  await ctx.notifyGoal(state,
    `**Goal Drive started:** ${goalName}\n` +
    `Branch: \`${goalBranch}\`\n` +
    `Tasks: ${state.tasks.length}\n` +
    `Max concurrent: ${maxConcurrent}` +
    (state.reviewerChannelId ? `\nReviewer: <#${state.reviewerChannelId}>` : ''),
    'success',
    { driveChannel: true },  // 唯一发送到 drive channel 的消息
  );

  await ctx.reviewAndDispatch(state);
  return state;
}

// ── pauseDrive ──────────────────────────────────────────────────────────

export async function pauseDrive(ctx: GoalOrchestrator, goalId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state || state.status !== 'running') return false;
  state.status = 'paused';
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Goal "${state.goalName}" paused`, 'warning');
  return true;
}

// ── pauseAllRunningDrives ───────────────────────────────────────────────

/**
 * 暂停所有正在运行的 Goal（紧急模式用）
 */
export async function pauseAllRunningDrives(ctx: GoalOrchestrator): Promise<void> {
  const runningGoals = [...ctx.activeDrives.entries()].filter(([, s]) => s.status === 'running');
  const results = await Promise.allSettled(
    runningGoals.map(([goalId]) => pauseDrive(ctx, goalId)),
  );
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    logger.warn(`[Orchestrator] Emergency: paused ${runningGoals.length - failed.length}/${runningGoals.length} goal(s), ${failed.length} failed`);
  } else {
    logger.info(`[Orchestrator] Emergency: paused ${runningGoals.length} running goal(s)`);
  }
}

// ── resumeDrive ─────────────────────────────────────────────────────────

export async function resumeDrive(ctx: GoalOrchestrator, goalId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state || state.status !== 'paused') return false;
  state.status = 'running';
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Goal "${state.goalName}" resumed`, 'success');

  // 确保 reviewer session 存在（Bot 重启后 paused drive 不经过 restoreRunningDrives）
  const guildId = ctx.getGuildId();
  if (guildId) {
    ctx.ensureGoalChannelSession(state, guildId);
  }

  await ctx.reviewAndDispatch(state);
  return true;
}

// ── getStatus ───────────────────────────────────────────────────────────

export async function getStatus(ctx: GoalOrchestrator, goalId: string): Promise<GoalDriveState | null> {
  return await ctx.getState(goalId);
}

// ── restoreRunningDrives ────────────────────────────────────────────────

export async function restoreRunningDrives(ctx: GoalOrchestrator): Promise<void> {
  const states = await ctx.deps.goalRepo.findByStatus('running');
  for (const state of states) {
    try {
      await stat(state.baseCwd);
    } catch {
      logger.error(`[Orchestrator] baseCwd does not exist for ${state.goalName}: ${state.baseCwd}`);
      state.status = 'paused';
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Goal "${state.goalName}" restore failed: working directory not found\n` +
        `Path: ${state.baseCwd}\n` +
        `Auto-paused. Check and resume manually.`,
        'error'
      );
      continue;
    }

    // Reset running/dispatched tasks: worktree missing → failed, else → pending (re-dispatch)
    let stateModified = false;
    for (const task of state.tasks) {
      if ((task.status === 'running' || task.status === 'dispatched') && task.branchName) {
        try {
          const stdout = await execGit(
            ['worktree', 'list', '--porcelain'],
            state.baseCwd,
            `restoreRunningDrives: check worktree for ${task.id}`
          );
          const worktreeDir = ctx.findWorktreeDir(stdout, task.branchName);
          if (!worktreeDir) {
            logger.warn(`[Orchestrator] Worktree missing for task ${task.id} (${task.branchName}), marking failed`);
            task.status = 'failed';
            task.error = 'Worktree not found after restart';
          } else {
            // Worktree exists but process is gone — reset to pending for re-dispatch
            logger.info(`[Orchestrator] Resetting task ${task.id} to pending for re-dispatch`);
            task.status = 'pending';
            task.branchName = undefined;
            task.channelId = undefined;
            task.dispatchedAt = undefined;
            task.pipelinePhase = undefined;
            task.auditRetries = 0;
          }
          stateModified = true;
        } catch {
          task.status = 'failed';
          task.error = 'Cannot verify worktree after restart';
          stateModified = true;
        }
      }
    }
    if (stateModified) await ctx.saveState(state);

    // 重建 completed+unmerged 任务的 hidden audit session
    // audit session 是无状态的（Claude 进程已消失），重建内存 entry 即可重新触发审核
    const guildIdForAudit = ctx.getGuildId();
    if (guildIdForAudit) {
      for (const task of state.tasks) {
        if (task.status === 'completed' && !task.merged && task.auditSessionKey) {
          // 先 archive 旧 active 记录（防止 zombie session），再重建
          ctx.deps.stateManager.archiveSession(guildIdForAudit, task.auditSessionKey, undefined, 'restart-cleanup');
          ctx.deps.stateManager.getOrCreateSession(guildIdForAudit, task.auditSessionKey, {
            name: `audit-${task.id}`,
            cwd: state.baseCwd,
            hidden: true,
          });
          ctx.deps.stateManager.setSessionModel(guildIdForAudit, task.auditSessionKey, ctx.deps.config.pipelineOpusModel);
          ctx.deps.stateManager.setSessionForkInfo(guildIdForAudit, task.auditSessionKey, state.goalChannelId, task.branchName ?? '');
          logger.info(`[Orchestrator] Restored hidden audit session for completed task ${task.id}`);
        }
      }
    }

    ctx.activeDrives.set(state.goalId, state);

    // 恢复 reviewer channel session（确保 cwd 和 Opus 模型正确设置）
    const guildId = ctx.getGuildId();
    if (guildId) {
      ctx.ensureGoalChannelSession(state, guildId);
    }

    logger.info(`[Orchestrator] Restored drive: ${state.goalName} (${state.goalId})`);
    await ctx.reviewAndDispatch(state);
  }
  if (states.length > 0) {
    logger.info(`[Orchestrator] Restored ${states.length} running drives`);
  }

  // 启动后台事件扫描器（兜底：处理 crash 后遗留的未处理事件）
  ctx.startEventScanner();
}
