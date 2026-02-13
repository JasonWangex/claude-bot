/**
 * GoalOrchestrator — Goal 自动调度引擎（Discord 版）
 *
 * 负责：
 * 1. 启动 Goal drive（创建 goal 分支 + Category Text Channel）
 * 2. 自动派发子任务到独立 worktree/Text Channel
 * 3. 监控子任务完成 → 自动 merge 到 goal 分支
 * 4. 全程通知用户，异常时暂停等待干预
 */

import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import { type MessageQueue, EmbedColors, type EmbedColor } from '../bot/message-queue.js';
import type { DiscordBotConfig, GoalDriveState, GoalTask, GoalTaskFeedback, PendingRollback } from '../types/index.js';
import type { IGoalRepo } from '../types/repository.js';
import { stat, readFile } from 'fs/promises';
import { join } from 'path';
import { getAuthorizedGuildId } from '../utils/env.js';
import { generateTopicTitle } from '../utils/llm.js';
import { execGit, resolveMainWorktree } from './git-ops.js';
import { parseTasks, goalNameToBranch, translateToBranchName } from './goal-state.js';
import { getNextBatch, isGoalComplete, isGoalStuck, getProgressSummary } from './task-scheduler.js';
import {
  createGoalBranch,
  createSubtaskBranch,
  mergeSubtaskBranch,
  cleanupSubtask,
  hasUncommittedChanges,
  autoCommit,
} from './goal-branch.js';
import { resolveConflictsWithAI } from './conflict-resolver.js';
import { logger } from '../utils/logger.js';
import {
  replanTasks,
  collectCompletedDiffStats,
  handleReplanByImpact,
  applyChanges,
  updateGoalBodyWithTasks,
  type ReplanContext,
  type ReplanChange,
} from './replanner.js';
import {
  buildReplanApprovalButtons,
  buildReplanRollbackButton,
  buildRollbackConfirmButtons,
} from './goal-buttons.js';
import type { IGoalMetaRepo, IGoalTaskRepo, IGoalCheckpointRepo } from '../types/repository.js';

interface OrchestratorDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  messageHandler: MessageHandler;
  client: Client;
  mq: MessageQueue;
  config: DiscordBotConfig;
  goalRepo: IGoalRepo;
  goalMetaRepo: IGoalMetaRepo;
  goalTaskRepo: IGoalTaskRepo;
  checkpointRepo: IGoalCheckpointRepo;
}

/** startDrive 的入参 */
export interface StartDriveParams {
  goalId: string;
  goalName: string;
  goalThreadId: string;
  baseCwd: string;
  tasks: Array<{
    id: string;
    description: string;
    type?: string;
    depends?: string[];
    phase?: number;
  }>;
  maxConcurrent?: number;
}

export class GoalOrchestrator {
  private deps: OrchestratorDeps;
  private mergeLocks = new Map<string, Promise<void>>();
  private stateLocks = new Map<string, Promise<void>>();
  private activeDrives = new Map<string, GoalDriveState>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * 串行化对同一 goal 的状态操作，防止并发 read-modify-write race condition
   */
  private async withStateLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.stateLocks.get(goalId) ?? Promise.resolve();
    let resolve: () => void;
    const current = new Promise<void>(r => { resolve = r; });
    this.stateLocks.set(goalId, current);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  /** 启动 Goal 自动推进 */
  async startDrive(params: StartDriveParams): Promise<GoalDriveState> {
    const { goalId, goalName, goalThreadId, baseCwd: inputCwd, tasks: rawTasks, maxConcurrent = 3 } = params;

    const existing = this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
    if (existing && (existing.status === 'running' || existing.status === 'paused')) {
      const hint = existing.status === 'paused' ? ' Use resumeDrive to continue.' : '';
      await this.notify(goalThreadId, `Goal "${goalName}" is already ${existing.status}.${hint}`, 'info');
      return existing;
    }

    let baseCwd: string;
    try {
      baseCwd = await resolveMainWorktree(inputCwd);
      if (baseCwd !== inputCwd) {
        logger.info(`[Orchestrator] Normalized baseCwd: ${inputCwd} → ${baseCwd}`);
      }
    } catch (err: any) {
      await this.notify(goalThreadId, `Invalid working directory: ${inputCwd}\nError: ${err.message}`, 'error');
      throw err;
    }

    const goalBranch = await goalNameToBranch(goalName);

    let goalWorktreeDir: string;
    try {
      goalWorktreeDir = await createGoalBranch(baseCwd, goalBranch, this.deps.config.worktreesDir);
    } catch (err: any) {
      await this.notify(goalThreadId, `Failed to create goal branch: ${err.message}`, 'error');
      throw err;
    }

    const state: GoalDriveState = {
      goalId,
      goalName,
      goalBranch,
      goalThreadId,
      baseCwd,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxConcurrent,
      tasks: parseTasks(rawTasks),
    };

    await this.saveState(state);
    this.activeDrives.set(goalId, state);

    await this.notify(goalThreadId,
      `**Goal Drive started:** ${goalName}\n` +
      `Branch: \`${goalBranch}\`\n` +
      `Tasks: ${state.tasks.length}\n` +
      `Max concurrent: ${maxConcurrent}`,
      'success'
    );

    await this.reviewAndDispatch(state);
    return state;
  }

  async pauseDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'running') return false;
    state.status = 'paused';
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Goal "${state.goalName}" paused`, 'warning');
    return true;
  }

  async resumeDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'paused') return false;
    state.status = 'running';
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Goal "${state.goalName}" resumed`, 'success');
    await this.reviewAndDispatch(state);
    return true;
  }

  async getStatus(goalId: string): Promise<GoalDriveState | null> {
    return await this.getState(goalId);
  }

  async skipTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    if (task.status !== 'pending' && task.status !== 'blocked' && task.status !== 'failed' && task.status !== 'paused') return false;

    // paused 任务可能有关联的进程，先清理
    if (task.status === 'paused' && task.threadId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.threadLockKey(guildId, task.threadId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'skipped';
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Skipped task: ${task.id} - ${task.description}`, 'info');
    if (state.status === 'running') await this.reviewAndDispatch(state);
    return true;
  }

  async markTaskDone(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'blocked') return false;
    task.status = 'completed';
    task.completedAt = Date.now();
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Manual task completed: ${task.id} - ${task.description}`, 'success');
    if (state.status === 'running') await this.reviewAndDispatch(state, taskId);
    return true;
  }

  async retryTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    if (task.status !== 'failed' && task.status !== 'blocked_feedback' && task.status !== 'paused') return false;

    // paused 任务可能还有运行中的进程（理论上不会，但防御性处理）
    if (task.status === 'paused' && task.threadId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.threadLockKey(guildId, task.threadId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'pending';
    task.error = undefined;
    task.branchName = undefined;
    task.threadId = undefined;
    task.dispatchedAt = undefined;
    task.merged = false;
    task.feedback = undefined;
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Retrying task: ${task.id} - ${task.description}`, 'warning');
    if (state.status === 'running') await this.reviewAndDispatch(state);
    return true;
  }

  /**
   * 暂停正在运行的任务：中止 Claude 子进程，保留 branch/thread/session 上下文
   */
  async pauseTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return false;

    // 中止运行中的 Claude 进程（保留队列，但任务暂停后不需要队列）
    if (task.threadId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.threadLockKey(guildId, task.threadId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'paused';
    // 保留 branchName, threadId, dispatchedAt — 恢复时复用
    await this.saveState(state);
    await this.notify(state.goalThreadId,
      `Paused task: ${task.id} - ${task.description}\nBranch/thread preserved for resume.`,
      'warning'
    );
    return true;
  }

  /**
   * 恢复暂停的任务：使用保留的 branch/thread 重新执行
   */
  async resumeTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'paused') return false;

    const guildId = this.getGuildId();
    if (!guildId) return false;

    // 任务有保留的 thread 和 branch → 在原有 thread 中继续执行
    if (task.threadId && task.branchName) {
      task.status = 'running';
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `Resumed task: ${task.id} - ${task.description}`,
        'success'
      );

      const taskPrompt = `[Resumed] Continue working on this task. Your previous progress has been preserved.\n\n` +
        this.buildTaskPrompt(task, state);
      this.executeTaskInBackground(state.goalId, task.id, guildId, task.threadId, taskPrompt);
      return true;
    }

    // 没有保留上下文 → 重置为 pending，重新派发
    task.status = 'pending';
    task.branchName = undefined;
    task.threadId = undefined;
    task.dispatchedAt = undefined;
    await this.saveState(state);
    await this.notify(state.goalThreadId,
      `Resumed task: ${task.id} - ${task.description} (re-dispatch)`,
      'success'
    );
    if (state.status === 'running') await this.dispatchNext(state);
    return true;
  }

  async restoreRunningDrives(): Promise<void> {
    const states = await this.deps.goalRepo.findByStatus('running');
    for (const state of states) {
      try {
        await stat(state.baseCwd);
      } catch {
        logger.error(`[Orchestrator] baseCwd does not exist for ${state.goalName}: ${state.baseCwd}`);
        state.status = 'paused';
        await this.saveState(state);
        await this.notify(state.goalThreadId,
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
            const worktreeDir = this.findWorktreeDir(stdout, task.branchName);
            if (!worktreeDir) {
              logger.warn(`[Orchestrator] Worktree missing for task ${task.id} (${task.branchName}), marking failed`);
              task.status = 'failed';
              task.error = 'Worktree not found after restart';
            } else {
              // Worktree exists but process is gone — reset to pending for re-dispatch
              logger.info(`[Orchestrator] Resetting task ${task.id} to pending for re-dispatch`);
              task.status = 'pending';
              task.branchName = undefined;
              task.threadId = undefined;
              task.dispatchedAt = undefined;
            }
            stateModified = true;
          } catch {
            task.status = 'failed';
            task.error = 'Cannot verify worktree after restart';
            stateModified = true;
          }
        }
      }
      if (stateModified) await this.saveState(state);

      this.activeDrives.set(state.goalId, state);
      logger.info(`[Orchestrator] Restored drive: ${state.goalName} (${state.goalId})`);
      await this.reviewAndDispatch(state);
    }
    if (states.length > 0) {
      logger.info(`[Orchestrator] Restored ${states.length} running drives`);
    }
  }

  // ========== 内部方法 ==========

  private async getState(goalId: string): Promise<GoalDriveState | null> {
    return this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
  }

  private async saveState(state: GoalDriveState): Promise<void> {
    state.updatedAt = Date.now();
    await this.deps.goalRepo.save(state);
  }

  /**
   * 增强型任务分发 — 在 dispatchNext() 前增加审查层
   *
   * 审查顺序：
   * 1. 占位任务检查：待分发队列若包含占位任务 → 强制 replan
   * 2. 调研任务深度审查：刚完成的调研任务（无显式 replan feedback）→ 触发深度审查 + replan
   * 3. Feedback 分发：有 blocked_feedback 状态的任务 → 按 feedback.type 路由
   * 4. 无触发条件 → 走原有 dispatchNext() 正常分发
   *
   * @param completedTaskId - 刚完成的任务 ID（可选，用于调研任务审查）
   */
  private async reviewAndDispatch(
    state: GoalDriveState,
    completedTaskId?: string,
  ): Promise<void> {
    if (state.status !== 'running') return;

    // ── 审查 1: 占位任务拦截 ──
    // 查看待分发队列中是否有占位任务变为可达状态（依赖已满足）
    const pendingPlaceholders = state.tasks.filter(t =>
      t.status === 'pending' && t.type === '占位' &&
      t.depends.every(depId => {
        const dep = state.tasks.find(d => d.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'skipped' || dep.status === 'cancelled');
      })
    );
    if (pendingPlaceholders.length > 0) {
      const placeholderIds = pendingPlaceholders.map(t => t.id).join(', ');
      logger.info(`[Orchestrator] Placeholder tasks ready: ${placeholderIds} — forcing replan`);
      await this.notify(state.goalThreadId,
        `**占位任务触发重规划:** ${placeholderIds}\n` +
        `占位任务的依赖已满足，需要重新规划将其替换为具体任务。`,
        'info',
      );

      // 用第一个占位任务触发 replan
      const trigger = pendingPlaceholders[0];
      await this.triggerReplan(state, trigger.id, {
        type: 'replan',
        reason: `占位任务 ${placeholderIds} 的依赖已满足，需要将占位任务替换为具体可执行任务`,
        details: `placeholder_ids: ${placeholderIds}`,
      });

      // replan 后刷新 state 再继续调度（replan 可能改变了任务图）
      const refreshed = await this.getState(state.goalId);
      if (refreshed && refreshed.status === 'running') {
        await this.dispatchNext(refreshed);
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
        await this.notify(state.goalThreadId,
          `**调研任务深度审查:** ${completedTask.id} - ${completedTask.description}\n` +
          `调研任务完成但未提交 replan feedback，自动触发深度审查。`,
          'info',
        );

        await this.triggerReplan(state, completedTask.id, {
          type: 'replan',
          reason: `调研任务 ${completedTask.id} 已完成，自动触发深度审查以评估调研结果对后续任务的影响`,
        });

        const refreshed = await this.getState(state.goalId);
        if (refreshed && refreshed.status === 'running') {
          await this.dispatchNext(refreshed);
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
          // blocked 类型：通知用户手动干预，不自动恢复
          // （已在 onTaskCompleted 中通知过，此处跳过避免重复通知）
          break;

        case 'clarify':
          // clarify 类型：通知用户需要澄清，不自动恢复
          break;

        case 'replan':
          // replan 类型正常应该在 onTaskCompleted 中已处理
          // 这里作为兜底：如果意外到达此状态，触发 replan
          logger.warn(`[Orchestrator] Unexpected replan feedback in blocked_feedback state: ${task.id}`);
          task.status = 'completed';
          task.completedAt = Date.now();
          await this.saveState(state);
          await this.triggerReplan(state, task.id, fb);
          const refreshed = await this.getState(state.goalId);
          if (refreshed && refreshed.status === 'running') {
            await this.dispatchNext(refreshed);
          }
          return;

        default:
          // 未知 feedback 类型：记录日志，不阻塞调度
          logger.warn(`[Orchestrator] Unknown feedback type "${fb.type}" on task ${task.id}`);
          break;
      }
    }

    // ── 审查通过：走正常分发 ──
    await this.dispatchNext(state);
  }

  private async dispatchNext(state: GoalDriveState): Promise<void> {
    if (state.status !== 'running') return;

    if (isGoalComplete(state)) {
      state.status = 'completed';
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `**Goal "${state.goalName}" completed!**\n` +
        `Review branch \`${state.goalBranch}\` and merge to main.`,
        'success'
      );
      return;
    }

    if (isGoalStuck(state)) {
      await this.notify(state.goalThreadId,
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
        await this.notify(state.goalThreadId,
          `Manual task pending: ${task.id} - ${task.description}\nReply "done ${task.id}" when complete.`,
          'warning'
        );
      }
    }

    await this.saveState(state);

    for (const task of batch) {
      await this.dispatchTask(state, task);
    }
  }

  private async dispatchTask(state: GoalDriveState, task: GoalTask): Promise<void> {
    const branchName = await this.generateBranchName(task);
    task.branchName = branchName;
    task.status = 'dispatched';
    task.dispatchedAt = Date.now();
    await this.saveState(state);

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `dispatchTask(${task.id}): list worktrees`
      );

      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        throw new Error(`Goal worktree for ${state.goalBranch} not found`);
      }

      const subtaskDir = await createSubtaskBranch(
        goalWorktreeDir,
        branchName,
        this.deps.config.worktreesDir
      );

      const guildId = this.getGuildId();
      if (!guildId) throw new Error('Bot not authorized');

      // 从 goal channel 向上查找 Category（支持 Thread → Channel → Category）
      let categoryId: string | null = null;
      try {
        let channel = await this.deps.client.channels.fetch(state.goalThreadId);
        for (let i = 0; i < 3 && channel; i++) {
          if (channel.type === ChannelType.GuildCategory) {
            categoryId = channel.id;
            break;
          }
          if ('parentId' in channel && channel.parentId) {
            channel = await this.deps.client.channels.fetch(channel.parentId);
          } else {
            break;
          }
        }
      } catch { /* ignore */ }

      if (!categoryId) {
        throw new Error('Cannot find Category for goal channel');
      }

      const guild = await this.deps.client.guilds.fetch(guildId);
      const title = await generateTopicTitle(task.description);
      const channelName = `${task.id} ${title}`.slice(0, 100);

      const textChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: `Goal subtask: ${task.id}`,
      });

      // 发送初始消息
      const initEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[goal] Task: \`${task.id}\` - ${task.description}\nBranch: \`${branchName}\`\nWorking directory: \`${subtaskDir}\``.slice(0, 4096));
      await textChannel.send({ embeds: [initEmbed] });

      const newThreadId = textChannel.id;

      this.deps.stateManager.getOrCreateSession(guildId, newThreadId, {
        name: channelName,
        cwd: subtaskDir,
      });
      this.deps.stateManager.setSessionForkInfo(guildId, newThreadId, state.goalThreadId, branchName);

      task.threadId = newThreadId;
      task.status = 'running';
      await this.saveState(state);

      await this.notify(state.goalThreadId,
        `Dispatched: ${task.id} - ${task.description} → \`${branchName}\``,
        'info'
      );

      const taskPrompt = this.buildTaskPrompt(task, state);
      this.executeTaskInBackground(state.goalId, task.id, guildId, newThreadId, taskPrompt);

    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `Dispatch failed: ${task.id} - ${task.description}\nError: ${err.message}`,
        'error'
      );
    }
  }

  private executeTaskInBackground(
    goalId: string,
    taskId: string,
    guildId: string,
    threadId: string,
    message: string
  ): void {
    (async () => {
      try {
        logger.info(`[Orchestrator] Task ${taskId} executing in channel ${threadId}`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, threadId, message);
        logger.info(`[Orchestrator] Task ${taskId} completed`);
        await this.onTaskCompleted(goalId, taskId);
      } catch (err: any) {
        logger.error(`[Orchestrator] Task ${taskId} failed:`, err.message);
        try {
          await this.onTaskFailed(goalId, taskId, err.message);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr.message);
        }
      }
    })();
  }

  private async onTaskCompleted(goalId: string, taskId: string): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      // 检测 feedback 文件：worktree/feedback/<taskId>.json
      const feedback = await this.checkFeedbackFile(state, task);
      if (feedback) {
        task.feedback = feedback;

        // replan 类型的 feedback → 自动触发重规划 + 分级自治
        if (feedback.type === 'replan') {
          task.status = 'completed';
          task.completedAt = Date.now();
          await this.saveState(state);

          await this.notify(state.goalThreadId,
            `**Replan feedback:** ${task.id} - ${task.description}\n` +
            `Reason: ${feedback.reason}`,
            'info'
          );

          // 触发重规划 + 分级自治
          await this.triggerReplan(state, task.id, feedback);

          // replan 后需刷新 state 再继续调度
          if (task.branchName) await this.mergeAndCleanup(state, task);
          const refreshed = await this.getState(goalId);
          if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
          return;
        }

        // 非 replan 类型 → 标记为 blocked_feedback 等待人工处理
        task.status = 'blocked_feedback';
        await this.saveState(state);
        await this.notify(state.goalThreadId,
          `**Feedback received:** ${task.id} - ${task.description}\n` +
          `Type: ${feedback.type}\n` +
          `Reason: ${feedback.reason}` +
          (feedback.details ? `\nDetails: ${feedback.details}` : ''),
          'warning'
        );
        // blocked_feedback 后也经过审查层，让 reviewAndDispatch 处理路由
        if (state.status === 'running') await this.reviewAndDispatch(state);
        return;
      }

      task.status = 'completed';
      task.completedAt = Date.now();
      await this.saveState(state);
      await this.notify(state.goalThreadId, `Completed: ${task.id} - ${task.description}`, 'success');
      if (task.branchName) await this.mergeAndCleanup(state, task);
      const refreshed = await this.getState(goalId);
      if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
    });
  }

  private async onTaskFailed(goalId: string, taskId: string, error: string): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'failed';
      task.error = error;
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `Failed: ${task.id} - ${task.description}\nError: ${error}\n\nReply "retry ${task.id}" to retry.`,
        'error'
      );
      if (state.status === 'running') await this.reviewAndDispatch(state);
    });
  }

  // ========== Replan 分级自治 ==========

  /**
   * 触发重规划 + 分级自治流程
   *
   * 1. 收集已完成任务的 diff stats
   * 2. 调用 LLM 生成 replan 结果
   * 3. 根据 impact_level 自动执行或暂停等待审批
   */
  private async triggerReplan(
    state: GoalDriveState,
    triggerTaskId: string,
    feedback: GoalTaskFeedback,
  ): Promise<void> {
    try {
      // 1. 收集 diff stats
      const completedDiffStats = await collectCompletedDiffStats(state);

      // 2. 获取 Goal 元数据
      const goalMeta = await this.deps.goalMetaRepo.get(state.goalId);

      // 3. 调用 LLM 生成 replan 结果
      const ctx: ReplanContext = {
        state,
        goalMeta,
        triggerTaskId,
        feedback,
        completedDiffStats,
      };

      const result = await replanTasks(ctx);
      if (!result || result.changes.length === 0) {
        await this.notify(state.goalThreadId,
          `Replan: 无需变更 — ${result?.reasoning ?? 'LLM 未返回结果'}`,
          'info',
        );
        return;
      }

      // 4. 分级自治处理
      const handleResult = await handleReplanByImpact(state, result, {
        goalTaskRepo: this.deps.goalTaskRepo,
        goalMetaRepo: this.deps.goalMetaRepo,
        checkpointRepo: this.deps.checkpointRepo,
        notify: (threadId, message, type, options) => this.notify(threadId, message, type, options),
      });

      if (handleResult.autoApplied) {
        logger.info(
          `[Orchestrator] Replan auto-applied (${handleResult.impactLevel}), goal ${state.goalId}`,
        );
      } else {
        // high impact — state.status 保持 running，但 pendingReplan 标记已设置
        // 等待用户 approve/reject
        logger.info(
          `[Orchestrator] Replan pending approval (high impact), goal ${state.goalId}`,
        );
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] triggerReplan failed: ${err.message}`);
      await this.notify(state.goalThreadId,
        `Replan 失败: ${err.message}`,
        'error',
      );
    }
  }

  /**
   * 用户审批 replan（approve replan）
   * 从 state.pendingReplan 读取待审批的变更并应用
   */
  async approveReplan(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;

    if (!state.pendingReplan) {
      await this.notify(state.goalThreadId, '没有待审批的计划变更', 'info');
      return false;
    }

    const pending = state.pendingReplan;

    // 应用变更
    const applyResult = await applyChanges(state, pending.changes as ReplanChange[], {
      goalTaskRepo: this.deps.goalTaskRepo,
      goalMetaRepo: this.deps.goalMetaRepo,
    });

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalThreadId,
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
      await this.reviewAndDispatch(state);
    }

    return true;
  }

  /**
   * 获取待审批 replan 变更的 JSON 文本（用于预填 Modal）
   */
  async getPendingReplanChangesJson(goalId: string): Promise<string | null> {
    const state = await this.getState(goalId);
    if (!state?.pendingReplan) return null;
    return JSON.stringify(state.pendingReplan.changes, null, 2);
  }

  /**
   * 用户修改后批准 replan（approve with modifications）
   * 解析用户修改后的变更 JSON 并应用
   */
  async approveReplanWithModifications(
    goalId: string,
    modifiedChangesJson: string,
  ): Promise<{ success: boolean; applied: number; rejected: number; error?: string }> {
    const state = await this.getState(goalId);
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
      goalTaskRepo: this.deps.goalTaskRepo,
      goalMetaRepo: this.deps.goalMetaRepo,
    });

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalThreadId,
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
      await this.reviewAndDispatch(state);
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
  async rejectReplan(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;

    const pending = state.pendingReplan;
    if (!pending) {
      await this.notify(state.goalThreadId, '没有待审批的计划变更', 'info');
      return false;
    }

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalThreadId,
      `🚫 **计划变更已拒绝**\n快照 ID: \`${pending.checkpointId}\``,
      'info',
    );

    // 恢复调度
    if (state.status === 'running') {
      await this.reviewAndDispatch(state);
    }

    return true;
  }

  // ========== 回滚流程 ==========

  /**
   * 回滚到指定检查点（第一阶段：评估）
   *
   * 1. 加载检查点，确定受影响的任务（在检查点之后 dispatch 的 running/dispatched/completed 任务）
   * 2. 立即 pause 所有受影响的 running 任务
   * 3. 评估成本（运行时间、git diff stat）
   * 4. 将评估结果发送给用户确认
   * 5. 存入 pendingRollback，等待 confirmRollback / cancelRollback
   *
   * @returns 成本评估结果（含 pendingRollback），null 表示失败
   */
  async rollback(goalId: string, checkpointId: string): Promise<PendingRollback | null> {
    return await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) {
        logger.error(`[Orchestrator] rollback: goal ${goalId} not found`);
        return null;
      }

      if (state.pendingRollback) {
        await this.notify(state.goalThreadId,
          `已有待确认的回滚操作（检查点: \`${state.pendingRollback.checkpointId}\`）\n` +
          `请先 \`confirm rollback\` 或 \`cancel rollback\``,
          'warning',
        );
        return null;
      }

      // 1. 加载检查点
      const checkpoint = await this.deps.checkpointRepo.get(checkpointId);
      if (!checkpoint) {
        await this.notify(state.goalThreadId, `检查点 \`${checkpointId}\` 不存在`, 'error');
        return null;
      }
      if (checkpoint.goalId !== goalId) {
        await this.notify(state.goalThreadId, `检查点 \`${checkpointId}\` 不属于此 Goal`, 'error');
        return null;
      }
      if (!checkpoint.tasksSnapshot) {
        await this.notify(state.goalThreadId, `检查点 \`${checkpointId}\` 没有任务快照`, 'error');
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
      const guildId = this.getGuildId();
      for (const affected of affectedTasks) {
        const task = state.tasks.find(t => t.id === affected.id);
        if (!task) continue;

        if (task.status === 'running') {
          // 中止 Claude 进程
          if (task.threadId && guildId) {
            const lockKey = StateManager.threadLockKey(guildId, task.threadId);
            this.deps.claudeClient.abort(lockKey);
          }
          task.status = 'paused';
          pausedTaskIds.push(task.id);
        } else if (task.status === 'dispatched') {
          task.status = 'paused';
          pausedTaskIds.push(task.id);
        }
      }

      // 4. 收集 git diff stats（评估代码产出量）
      const worktreeListOutput = await this.safeListWorktrees(state.baseCwd);
      for (const affected of affectedTasks) {
        const task = state.tasks.find(t => t.id === affected.id);
        if (!task?.branchName || !worktreeListOutput) continue;

        try {
          const goalWorktreeDir = this.findWorktreeDir(worktreeListOutput, state.goalBranch);
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
      const costSummary = this.buildRollbackCostSummary(affectedTasks, checkpoint);

      // 6. 构建 PendingRollback 并存入 state
      const pendingRollback: PendingRollback = {
        checkpointId,
        pausedTaskIds,
        costSummary,
        affectedTasks,
        createdAt: Date.now(),
      };

      state.pendingRollback = pendingRollback;
      await this.saveState(state);

      // 7. 通知用户确认（含确认/取消按钮）
      const confirmMessage =
        `⏪ **回滚评估：检查点 \`${checkpointId}\`**\n\n` +
        costSummary;

      await this.notify(state.goalThreadId, confirmMessage, 'warning', {
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
  async confirmRollback(goalId: string): Promise<boolean> {
    return await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return false;

      const pending = state.pendingRollback;
      if (!pending) {
        await this.notify(state.goalThreadId, '没有待确认的回滚操作', 'info');
        return false;
      }

      const guildId = this.getGuildId();

      // 1. 恢复检查点的任务快照
      const snapshotTasks = await this.deps.checkpointRepo.restoreCheckpoint(pending.checkpointId);
      if (!snapshotTasks) {
        await this.notify(state.goalThreadId,
          `回滚失败：检查点 \`${pending.checkpointId}\` 快照数据不可用`,
          'error',
        );
        delete state.pendingRollback;
        await this.saveState(state);
        return false;
      }

      // 2. 收集需要清理的任务（当前 state 中有 branch/thread 但快照中不存在或状态不同的任务）
      const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));
      const tasksToCleanup: GoalTask[] = [];

      for (const task of state.tasks) {
        const snapshotTask = snapshotTaskMap.get(task.id);

        // 任务在快照中不存在（replan 新增的）→ 需要清理
        if (!snapshotTask) {
          if (task.branchName || task.threadId) {
            tasksToCleanup.push(task);
          }
          continue;
        }

        // 任务在快照中是 pending 但现在有 branch/thread → 需要清理
        if (snapshotTask.status === 'pending' && (task.branchName || task.threadId)) {
          tasksToCleanup.push(task);
        }
      }

      // 3. 清理受影响任务的资源（stop 进程 + 删除 worktree/分支 + 删除 Discord channel）
      const worktreeListOutput = await this.safeListWorktrees(state.baseCwd);

      for (const task of tasksToCleanup) {
        // 停止进程
        if (task.threadId && guildId) {
          const lockKey = StateManager.threadLockKey(guildId, task.threadId);
          this.deps.claudeClient.abort(lockKey);
        }

        // 清理 worktree 和分支
        if (task.branchName && worktreeListOutput) {
          const subtaskDir = this.findWorktreeDir(worktreeListOutput, task.branchName);
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
        if (task.threadId) {
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.threadId, undefined, 'rollback');
          }
          try {
            const channel = await this.deps.client.channels.fetch(task.threadId);
            if (channel && 'delete' in channel) {
              await (channel as any).delete('Rolled back').catch(() => {});
            }
          } catch { /* ignore */ }
        }
      }

      // 4. Git reset goal 分支到检查点 commit（如果检查点有 gitRef）
      const checkpoint = await this.deps.checkpointRepo.get(pending.checkpointId);
      if (checkpoint?.gitRef && worktreeListOutput) {
        const goalWorktreeDir = this.findWorktreeDir(worktreeListOutput, state.goalBranch);
        if (goalWorktreeDir) {
          try {
            await execGit(['reset', '--hard', checkpoint.gitRef], goalWorktreeDir,
              `rollback: reset goal branch to ${checkpoint.gitRef}`);
            logger.info(`[Orchestrator] rollback: reset ${state.goalBranch} to ${checkpoint.gitRef}`);
          } catch (err: any) {
            logger.warn(`[Orchestrator] rollback: git reset failed: ${err.message}`);
            await this.notify(state.goalThreadId,
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
      await this.deps.goalTaskRepo.saveAll(state.goalId, snapshotTasks);
      await this.saveState(state);

      // 更新 Goal body
      const goalMeta = await this.deps.goalMetaRepo.get(state.goalId);
      if (goalMeta) {
        goalMeta.body = updateGoalBodyWithTasks(goalMeta.body, snapshotTasks);
        const completed = snapshotTasks.filter(t => t.status === 'completed').length;
        const active = snapshotTasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
        goalMeta.progress = `${completed}/${active} 子任务完成`;
        await this.deps.goalMetaRepo.save(goalMeta);
      }

      const cleanedCount = tasksToCleanup.length;
      await this.notify(state.goalThreadId,
        `✅ **回滚完成**\n` +
        `已恢复到检查点 \`${pending.checkpointId}\`\n` +
        `清理了 ${cleanedCount} 个受影响任务的资源\n` +
        `任务计划已恢复，继续调度...`,
        'success',
      );

      // 6. 恢复调度
      if (state.status === 'running') {
        await this.reviewAndDispatch(state);
      }

      return true;
    });
  }

  /**
   * 取消回滚：恢复已暂停的任务
   */
  async cancelRollback(goalId: string): Promise<boolean> {
    return await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return false;

      const pending = state.pendingRollback;
      if (!pending) {
        await this.notify(state.goalThreadId, '没有待确认的回滚操作', 'info');
        return false;
      }

      const guildId = this.getGuildId();

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
          task.threadId = undefined;
          task.dispatchedAt = undefined;
        }
      }

      delete state.pendingRollback;
      await this.saveState(state);

      await this.notify(state.goalThreadId,
        `🚫 **回滚已取消**\n已暂停的任务将重新分发`,
        'info',
      );

      // 恢复调度
      if (state.status === 'running') {
        await this.reviewAndDispatch(state);
      }

      return true;
    });
  }

  /**
   * 生成回滚成本评估摘要
   */
  private buildRollbackCostSummary(
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

  /**
   * 安全获取 worktree 列表，失败返回 null
   */
  private async safeListWorktrees(baseCwd: string): Promise<string | null> {
    try {
      return await execGit(
        ['worktree', 'list', '--porcelain'],
        baseCwd,
        'rollback: list worktrees',
      );
    } catch {
      return null;
    }
  }

  // ========== Feedback 检测 ==========

  /**
   * 检测子任务 worktree 下的 feedback/<taskId>.json
   * 存在且合法则返回 feedback 内容，否则返回 null
   */
  private async checkFeedbackFile(state: GoalDriveState, task: GoalTask): Promise<GoalTaskFeedback | null> {
    if (!task.branchName) return null;

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `checkFeedbackFile(${task.id}): list worktrees`
      );
      const subtaskDir = this.findWorktreeDir(stdout, task.branchName);
      if (!subtaskDir) return null;

      const feedbackPath = join(subtaskDir, 'feedback', `${task.id}.json`);
      const content = await readFile(feedbackPath, 'utf-8');
      const parsed = JSON.parse(content);

      // 校验必须字段
      if (!parsed.type || !parsed.reason) {
        logger.warn(`[Orchestrator] Invalid feedback file for ${task.id}: missing type or reason`);
        return null;
      }

      return {
        type: parsed.type,
        reason: parsed.reason,
        details: parsed.details,
      };
    } catch {
      // 文件不存在或读取/解析失败 → 无 feedback
      return null;
    }
  }

  private async mergeAndCleanup(state: GoalDriveState, task: GoalTask): Promise<void> {
    if (!task.branchName) return;

    // Per-goal merge lock: queue merges for the same goal, allow different goals concurrently
    const goalId = state.goalId;
    const prev = this.mergeLocks.get(goalId) || Promise.resolve();
    const current = prev.then(() => this.doMergeAndCleanup(state, task)).catch(() => {});
    this.mergeLocks.set(goalId, current);
    await current;
  }

  private async doMergeAndCleanup(state: GoalDriveState, task: GoalTask): Promise<void> {
    if (!task.branchName) return;
    const branchName = task.branchName;

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `mergeAndCleanup(${branchName}): list worktrees`
      );
      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        await this.notify(state.goalThreadId, `Cannot find goal worktree, skipping merge: ${branchName}`, 'warning');
        return;
      }

      const subtaskDir = this.findWorktreeDir(stdout, branchName);
      if (subtaskDir) {
        const hasChanges = await hasUncommittedChanges(subtaskDir);
        if (hasChanges) {
          await autoCommit(subtaskDir, `auto: ${task.description}`);
        }
      }

      const result = await mergeSubtaskBranch(goalWorktreeDir, branchName);

      if (result.success) {
        task.merged = true;
        await this.saveState(state);
        await this.notify(state.goalThreadId, `Merged: \`${branchName}\` → \`${state.goalBranch}\``, 'success');

        if (subtaskDir) {
          await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
        }

        // Delete subtask channel
        if (task.threadId) {
          const guildId = this.getGuildId();
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.threadId, undefined, 'merged');
            try {
              const channel = await this.deps.client.channels.fetch(task.threadId);
              if (channel && 'delete' in channel) {
                await (channel as any).delete('Task merged and cleaned up').catch(() => {});
              }
            } catch { /* ignore */ }
          }
        }
      } else if (result.conflict) {
        // 尝试 AI 自动解决冲突
        await this.notify(state.goalThreadId,
          `Merge conflict: \`${branchName}\` → \`${state.goalBranch}\`, trying AI resolution...`,
          'warning'
        );

        const resolution = await resolveConflictsWithAI(
          this.deps.claudeClient,
          goalWorktreeDir,
          branchName,
          task.description,
        );

        if (resolution.resolved) {
          task.merged = true;
          await this.saveState(state);
          await this.notify(state.goalThreadId,
            `AI resolved conflict and merged: \`${branchName}\` → \`${state.goalBranch}\``,
            'success'
          );

          if (subtaskDir) {
            await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
          }

          if (task.threadId) {
            const guildId = this.getGuildId();
            if (guildId) {
              this.deps.stateManager.archiveSession(guildId, task.threadId, undefined, 'merged');
              try {
                const channel = await this.deps.client.channels.fetch(task.threadId);
                if (channel && 'delete' in channel) {
                  await (channel as any).delete('Task merged and cleaned up').catch(() => {});
                }
              } catch { /* ignore */ }
            }
          }
        } else {
          // AI 无法解决，fallback 到人工干预
          await this.notify(state.goalThreadId,
            `AI could not resolve conflict: \`${branchName}\` → \`${state.goalBranch}\`\n` +
            `Reason: ${resolution.error}\n` +
            `Manual resolution needed. Reply "done ${task.id}" when resolved.`,
            'error'
          );
          task.status = 'blocked';
          task.error = 'merge conflict (AI resolution failed)';
          await this.saveState(state);
        }
      } else {
        await this.notify(state.goalThreadId, `Merge failed: ${branchName}\nError: ${result.error}`, 'error');
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] mergeAndCleanup error: ${err.message}`);
    }
  }

  private async generateBranchName(task: GoalTask): Promise<string> {
    const prefix = task.type === '调研' ? 'research' : 'feat';
    const translated = await translateToBranchName(task.description);
    return `${prefix}/${task.id}-${translated.slice(0, 30) || 'task'}`;
  }

  private buildTaskPrompt(task: GoalTask, state: GoalDriveState): string {
    const lines: string[] = [
      `You are a subtask executor for Goal "${state.goalName}".`,
      ``,
      `## Current Task`,
      `ID: ${task.id}`,
      `Type: ${task.type}`,
      `Description: ${task.description}`,
    ];

    // 依赖上下文：列出已完成的前置任务，帮助 executor 理解背景
    if (task.depends.length > 0) {
      const depInfos = task.depends.map(depId => {
        const dep = state.tasks.find(t => t.id === depId);
        return dep ? `  - ${dep.id}: ${dep.description} (${dep.status})` : `  - ${depId}: (unknown)`;
      });
      lines.push(``, `## Dependencies (completed before this task)`, ...depInfos);
    }

    // 通用要求
    lines.push(
      ``,
      `## Requirements`,
      `1. Focus on completing the task above`,
      `2. Ensure all code is saved when done`,
      `3. If you need user decisions, ask clearly`,
      `4. Do not modify code unrelated to this task`,
    );

    // ── Feedback 协议 ──
    lines.push(
      ``,
      `## Feedback Protocol`,
      `When you encounter situations described below, write a feedback file and then **end your session**.`,
      ``,
      `**File path:** \`feedback/${task.id}.json\` (relative to working directory)`,
      `**Format:**`,
      '```json',
      `{`,
      `  "type": "replan" | "blocked" | "clarify",`,
      `  "reason": "brief summary of why",`,
      `  "details": {}  // optional, structured data depending on type`,
      `}`,
      '```',
      ``,
      `After writing the feedback file, you MUST \`git add\` and \`git commit\` it, then **stop working**. The orchestrator will read your feedback and decide the next action.`,
    );

    // ── 调研任务特殊规则 ──
    if (task.type === '调研') {
      lines.push(
        ``,
        `## Research Task Rules`,
        `This is a **research task**. When you finish your research:`,
        `1. You **MUST** write a feedback file before ending`,
        `2. Use \`type: "replan"\` with your findings in \`details\``,
        `3. Example:`,
        '```json',
        `{`,
        `  "type": "replan",`,
        `  "reason": "Research completed — findings may affect task plan",`,
        `  "details": {`,
        `    "findings": "Your research conclusions here",`,
        `    "recommendations": ["actionable suggestion 1", "suggestion 2"],`,
        `    "affectedTasks": ["t3", "t4"]`,
        `  }`,
        `}`,
        '```',
        `4. Do NOT write implementation code — only research, document, and report back via feedback`,
      );
    }

    // ── 阻塞触发场景 ──
    lines.push(
      ``,
      `## When to Write Feedback`,
      `Write a feedback file (and stop) if any of these occur:`,
      `- **Blocked:** You hit a technical blocker you cannot resolve (missing API, wrong architecture, external dependency). Use \`type: "blocked"\`, describe the blocker in \`reason\`, and include attempted solutions in \`details\`.`,
      `- **Needs Clarification:** The task description is ambiguous or you discover conflicting requirements. Use \`type: "clarify"\`, list your questions in \`details.questions\`.`,
      `- **Scope Mismatch:** You realize the task requires changes far beyond its description, or should be split into multiple tasks. Use \`type: "replan"\`, describe the discovered scope in \`details\`.`,
      `- **Dependency Issue:** A completed dependency task is incorrect or insufficient for your work. Use \`type: "blocked"\`, reference the dependency in \`details.dependencyId\`.`,
    );

    // ── 占位任务引导 ──
    if (task.type === '占位') {
      lines.push(
        ``,
        `## Placeholder Task`,
        `This is a **placeholder task**. It exists as a structural marker in the task graph.`,
        `- Placeholder tasks are normally NOT dispatched automatically.`,
        `- If you are seeing this, the task was triggered manually or by an unusual condition.`,
        `- **Do not write code.** Instead, write a \`type: "clarify"\` feedback asking the orchestrator why this task was dispatched, then stop.`,
      );
    }

    return lines.join('\n');
  }

  private findWorktreeDir(worktreeListOutput: string, branchName: string): string | null {
    const lines = worktreeListOutput.split('\n');
    let currentWorktree = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentWorktree = line.slice('worktree '.length);
      }
      if (line.startsWith('branch ') && line.includes(branchName)) {
        return currentWorktree;
      }
    }
    return null;
  }

  private async notify(
    threadId: string,
    message: string,
    type?: 'success' | 'error' | 'warning' | 'info',
    options?: { components?: import('discord.js').ActionRowBuilder<import('discord.js').ButtonBuilder>[] },
  ): Promise<void> {
    try {
      const colorMap: Record<string, EmbedColor> = {
        success: EmbedColors.GREEN,
        error: EmbedColors.RED,
        warning: EmbedColors.YELLOW,
        info: EmbedColors.GRAY,
      };
      const embedColor = type ? colorMap[type] : undefined;
      await this.deps.mq.sendLong(threadId, message, {
        embedColor,
        components: options?.components as any,
      });
    } catch (err: any) {
      logger.error(`[Orchestrator] Failed to send notification: ${err.message}`);
    }
  }

  private getGuildId(): string | null {
    return getAuthorizedGuildId() ?? null;
  }
}
