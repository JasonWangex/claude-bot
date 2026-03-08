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
import { GoalDriveStatus, TaskStatus } from '../types/index.js';
import type { StartDriveParams } from './orchestrator-types.js';
import { NotifyType } from './orchestrator-types.js';
import { GoalStatus } from '../types/db.js';
import type { GoalOrchestrator } from './index.js';

// ── startDrive ──────────────────────────────────────────────────────────

export async function startDrive(ctx: GoalOrchestrator, params: StartDriveParams): Promise<GoalDriveState> {
  const { goalId, goalName, goalChannelId, baseCwd: inputCwd, maxConcurrent = 3 } = params;

  // 已有 drive 时：paused → 自动 resume；running → 直接返回当前状态
  const existing = await ctx.deps.goalRepo.get(goalId);
  if (existing) {
    if (existing.status === GoalDriveStatus.Paused) {
      logger.info(`[Orchestrator] Goal "${goalName}" is paused, auto-resuming`);
      await resumeDrive(ctx, goalId);
      return (await ctx.deps.goalRepo.get(goalId)) ?? existing;
    }
    if (existing.status === GoalDriveStatus.Running) {
      await ctx.notify(goalChannelId, `Goal "${goalName}" is already running.`, NotifyType.Info);
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
    await ctx.notify(goalChannelId, `Invalid working directory: ${inputCwd}\nError: ${err.message}`, NotifyType.Error);
    throw err;
  }

  const branch = await goalNameToBranch(goalName);

  let goalWorktreeDir: string;
  try {
    goalWorktreeDir = await createGoalBranch(baseCwd, branch, ctx.deps.config.worktreesDir);
  } catch (err: any) {
    await ctx.notify(goalChannelId, `Failed to create goal branch: ${err.message}`, NotifyType.Error);
    throw err;
  }

  // 获取 goalMeta（seq + body）
  const goalMeta = await ctx.deps.goalRepo.getMeta(goalId);
  const goalSeq = goalMeta?.seq ?? 0;

  // tasks 由 Claude 提前通过 bot_goal_tasks(action="set") 写入 DB
  const storedTasks = await ctx.deps.taskRepo.getAllByGoal(goalId);
  if (storedTasks.length === 0) {
    const err = new Error(`No tasks found for goal ${goalId}. Use bot_goal_tasks(action="set") to initialize tasks before starting drive.`);
    await ctx.notify(goalChannelId, err.message, NotifyType.Error);
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
    branch,
    channelId: goalChannelId,
    cwd: baseCwd,
    status: GoalDriveStatus.Running,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxConcurrent,
    tasks,
  };

  // 创建 Tech Lead 专用 channel（与 goal channel 同一 Category 下）
  const guildId = ctx.getGuildId();
  if (guildId) {
    try {
      const categoryId = await ctx.findCategoryId(goalChannelId);
      if (categoryId) {
        const guild = await ctx.deps.client.guilds.fetch(guildId);
        const techLeadChannel = await guild.channels.create({
          name: `g${goalSeq}-tech-lead`,
          type: ChannelType.GuildText,
          parent: categoryId,
          reason: `Goal tech lead: ${goalName}`,
        });
        state.techLeadChannelId = techLeadChannel.id;
        logger.info(`[Orchestrator] Created tech lead channel: ${techLeadChannel.id} for goal ${goalId}`);
      } else {
        logger.warn(`[Orchestrator] Cannot find Category for goal channel ${goalChannelId}, tech lead will use goal channel`);
      }
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to create tech lead channel: ${err.message}, falling back to goal channel`);
    }
  }

  await ctx.saveState(state);

  // 为 Tech Lead channel 创建 Opus 会话并发送初始化 prompt
  if (guildId) {
    ctx.ensureGoalChannelSession(state, guildId);
    const techLeadChannelId = state.techLeadChannelId ?? state.channelId;
    const initPrompt = ctx.deps.promptService.render('orchestrator.tech_lead_init', {
      GOAL_NAME: goalName,
      GOAL_BRANCH: branch,
      GOAL_ID: goalId,
      GOAL_SEQ: String(state.goalSeq),
    });
    try {
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, techLeadChannelId, initPrompt, 'drive');
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to send tech lead init prompt: ${err.message}`);
    }
  }

  await ctx.notifyGoal(state,
    `**Goal Drive started:** ${goalName}\n` +
    `Branch: \`${branch}\`\n` +
    `Tasks: ${state.tasks.length}\n` +
    `Max concurrent: ${maxConcurrent}` +
    (state.techLeadChannelId ? `\nTech Lead: <#${state.techLeadChannelId}>` : ''),
    NotifyType.Success,
    { driveChannel: true },
  );

  await ctx.reviewAndDispatch(state);
  return state;
}

// ── pauseDrive ──────────────────────────────────────────────────────────

export async function pauseDrive(ctx: GoalOrchestrator, goalId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state || state.status !== GoalDriveStatus.Running) return false;
  state.status = GoalDriveStatus.Paused;
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Goal "${state.goalName}" paused`, NotifyType.Warning);
  return true;
}

// ── pauseAllRunningDrives ───────────────────────────────────────────────

/**
 * 暂停所有活跃 Goal（紧急模式用）
 */
export async function pauseAllRunningDrives(ctx: GoalOrchestrator): Promise<void> {
  const activeGoals = await ctx.deps.goalRepo.findByStatuses([GoalStatus.Processing, GoalStatus.Paused, GoalStatus.Blocking]);
  const results = await Promise.allSettled(
    activeGoals.map(state => pauseDrive(ctx, state.goalId)),
  );
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    logger.warn(`[Orchestrator] Emergency: paused ${activeGoals.length - failed.length}/${activeGoals.length} goal(s), ${failed.length} failed`);
  } else {
    logger.info(`[Orchestrator] Emergency: paused ${activeGoals.length} active goal(s)`);
  }
}

// ── resumeDrive ─────────────────────────────────────────────────────────

export async function resumeDrive(ctx: GoalOrchestrator, goalId: string): Promise<boolean> {
  const state = await ctx.getState(goalId);
  if (!state || state.status !== GoalDriveStatus.Paused) return false;
  state.status = GoalDriveStatus.Running;
  await ctx.saveState(state);
  await ctx.notifyGoal(state, `Goal "${state.goalName}" resumed`, NotifyType.Success);

  // 确保 tech lead session 存在
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
  const states = await ctx.deps.goalRepo.findByStatuses([GoalStatus.Processing]);
  for (const state of states) {
    try {
      await stat(state.cwd);
    } catch {
      logger.error(`[Orchestrator] cwd does not exist for ${state.goalName}: ${state.cwd}`);
      state.status = GoalDriveStatus.Paused;
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Goal "${state.goalName}" restore failed: working directory not found\n` +
        `Path: ${state.cwd}\n` +
        `Auto-paused. Check and resume manually.`,
        NotifyType.Error
      );
      continue;
    }

    // Reset running/dispatched tasks: worktree missing → failed, else → pending (re-dispatch)
    let stateModified = false;
    for (const task of state.tasks) {
      if ((task.status === TaskStatus.Running || task.status === TaskStatus.Dispatched) && task.branchName) {
        try {
          const stdout = await execGit(
            ['worktree', 'list', '--porcelain'],
            state.cwd,
            `restoreRunningDrives: check worktree for ${task.id}`
          );
          const worktreeDir = ctx.findWorktreeDir(stdout, task.branchName);
          if (!worktreeDir) {
            logger.warn(`[Orchestrator] Worktree missing for task ${task.id} (${task.branchName}), marking failed`);
            task.status = TaskStatus.Failed;
            task.error = 'Worktree not found after restart';
          } else {
            logger.info(`[Orchestrator] Resetting task ${task.id} to pending for re-dispatch`);
            task.status = TaskStatus.Pending;
            task.branchName = undefined;
            task.channelId = undefined;
            task.dispatchedAt = undefined;
            task.pipelinePhase = undefined;
            task.auditRetries = 0;
          }
          stateModified = true;
        } catch {
          task.status = TaskStatus.Failed;
          task.error = 'Cannot verify worktree after restart';
          stateModified = true;
        }
      }
    }
    if (stateModified) await ctx.saveState(state);

    // 重建 completed+unmerged 任务的 hidden audit session
    const guildIdForAudit = ctx.getGuildId();
    if (guildIdForAudit) {
      for (const task of state.tasks) {
        if (task.status === TaskStatus.Completed && !task.merged && task.auditSessionKey) {
          ctx.deps.stateManager.archiveSession(guildIdForAudit, task.auditSessionKey, undefined, 'restart-cleanup');
          ctx.deps.stateManager.getOrCreateSession(guildIdForAudit, task.auditSessionKey, {
            name: `audit-${task.id}`,
            cwd: state.cwd,
            hidden: true,
          });
          ctx.deps.stateManager.setSessionModel(guildIdForAudit, task.auditSessionKey, ctx.deps.config.pipelineOpusModel);
          ctx.deps.stateManager.setSessionForkInfo(guildIdForAudit, task.auditSessionKey, state.channelId, task.branchName ?? '');
          logger.info(`[Orchestrator] Restored hidden audit session for completed task ${task.id}`);
        }
      }
    }

    // 恢复 tech lead channel session
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

  // 启动后台事件扫描器
  ctx.startEventScanner();
}
