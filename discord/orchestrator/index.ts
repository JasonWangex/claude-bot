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
import type { DiscordBotConfig, GoalDriveState, GoalTask, GoalTaskFeedback, PipelinePhase, PendingRollback, ChatUsageResult } from '../types/index.js';
import type { IGoalRepo } from '../types/repository.js';
import { stat } from 'fs/promises';
import { getAuthorizedGuildId, getGoalLogChannelId } from '../utils/env.js';
import { generateTopicTitle } from '../utils/llm.js';
import { execGit, resolveMainWorktree } from './git-ops.js';
import { parseTasks, goalNameToBranch, translateToBranchName } from './goal-state.js';
import { getNextBatch, isGoalComplete, isGoalStuck, getProgressSummary, getPhaseNumber, isPhaseFullyMerged, getCurrentPhase } from './task-scheduler.js';
import { parseTaskDetailPlans, formatDetailPlanForPrompt } from './goal-body-parser.js';
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
  type ReplanResult,
} from './replanner.js';
import {
  buildReplanApprovalButtons,
  buildReplanRollbackButton,
  buildRollbackConfirmButtons,
  buildTaskFailedButtons,
} from './goal-buttons.js';
import type { IGoalMetaRepo, ITaskRepo, IGoalCheckpointRepo, IGoalTodoRepo } from '../types/repository.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';
import { TaskEventRepo } from '../db/repo/task-event-repo.js';

interface OrchestratorDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  messageHandler: MessageHandler;
  client: Client;
  mq: MessageQueue;
  config: DiscordBotConfig;
  goalRepo: IGoalRepo;
  goalMetaRepo: IGoalMetaRepo;
  taskRepo: ITaskRepo;
  checkpointRepo: IGoalCheckpointRepo;
  goalTodoRepo: IGoalTodoRepo;
  promptService: PromptConfigService;
  taskEventRepo: TaskEventRepo;
}

interface MergeConflictPayload {
  branchName: string;
  goalWorktreeDir: string;
  subtaskDir: string | null;
  taskDescription: string;
  error: string;
}

/** startDrive 的入参 */
export interface StartDriveParams {
  goalId: string;
  goalName: string;
  goalChannelId: string;
  baseCwd: string;
  tasks: Array<{
    id: string;
    description: string;
    type?: string;
    phase?: number;
    complexity?: string;
  }>;
  maxConcurrent?: number;
}

export class GoalOrchestrator {
  private deps: OrchestratorDeps;
  private mergeLocks = new Map<string, Promise<void>>();
  private stateLocks = new Map<string, Promise<void>>();
  private activeDrives = new Map<string, GoalDriveState>();

  // Check-in 监工状态
  private checkInCounts = new Map<string, number>();    // taskId → check-in 次数
  private lastCheckInAt = new Map<string, number>();    // taskId → 上次 check-in 时间

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** 任务标签（task ID 已含 goal seq 前缀，如 g2t1） */
  private getTaskLabel(_state: GoalDriveState, taskId: string): string {
    return taskId;
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

  /** 同步 Goal 元数据 status（GoalMetaRepo 管理的 status 字段） */
  private async syncGoalMetaStatus(goalId: string, status: string): Promise<void> {
    try {
      const meta = await this.deps.goalMetaRepo.get(goalId);
      if (meta) {
        meta.status = status as any;
        await this.deps.goalMetaRepo.save(meta);
      }
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to sync goal meta status: ${err.message}`);
    }
  }

  /** 同步 Goal 元数据（progress / next / blockedBy / status） */
  private async syncGoalMeta(state: GoalDriveState): Promise<void> {
    try {
      const meta = await this.deps.goalMetaRepo.get(state.goalId);
      if (!meta) return;

      // 进度（JSON 格式存储）
      const total = state.tasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
      const completed = state.tasks.filter(t => t.status === 'completed' && (!t.branchName || t.merged)).length;
      const running = state.tasks.filter(t => t.status === 'dispatched' || t.status === 'running').length;
      const failed = state.tasks.filter(t => t.status === 'failed').length;
      meta.progress = JSON.stringify({ completed, total, running, failed });

      // 状态 + next + blockedBy
      if (isGoalComplete(state)) {
        meta.status = 'Completed';
        meta.next = `审查 ${state.goalBranch} 分支并合并到 main`;
        meta.blockedBy = null;
      } else if (isGoalStuck(state)) {
        meta.status = 'Blocking';
        meta.blockedBy = this.getStuckReason(state);
        meta.next = null;
      } else {
        meta.status = 'Processing';
        meta.blockedBy = null;
        meta.next = this.getNextStepSummary(state);
      }

      await this.deps.goalMetaRepo.save(meta);
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to sync goal meta: ${err.message}`);
    }
  }

  /** 获取 Goal 卡住的原因描述 */
  private getStuckReason(state: GoalDriveState): string {
    const reasons: string[] = [];

    const blockedFeedback = state.tasks.filter(t => t.status === 'blocked_feedback');
    if (blockedFeedback.length > 0) {
      reasons.push(`${blockedFeedback.length} 个任务有待处理反馈`);
    }

    const paused = state.tasks.filter(t => t.status === 'paused');
    if (paused.length > 0) {
      reasons.push(`${paused.length} 个任务已暂停`);
    }

    const unmerged = state.tasks.filter(t => t.status === 'completed' && t.branchName && !t.merged);
    if (unmerged.length > 0) {
      reasons.push(`${unmerged.length} 个任务完成但合并失败`);
    }

    const failed = state.tasks.filter(t => t.status === 'failed');
    if (failed.length > 0) {
      reasons.push(`${failed.length} 个任务执行失败`);
    }

    if (reasons.length === 0) {
      reasons.push('存在无法满足的依赖关系');
    }

    return reasons.join('; ');
  }

  /** 获取下一步描述 */
  private getNextStepSummary(state: GoalDriveState): string {
    const running = state.tasks.filter(t => t.status === 'dispatched' || t.status === 'running');
    if (running.length > 0) {
      const labels = running.map(t => this.getTaskLabel(state, t.id)).join(', ');
      return `正在执行: ${labels}`;
    }
    return getProgressSummary(state);
  }

  /** 启动 Goal 自动推进 */
  async startDrive(params: StartDriveParams): Promise<GoalDriveState> {
    const { goalId, goalName, goalChannelId, baseCwd: inputCwd, tasks: rawTasks, maxConcurrent = 3 } = params;

    const existing = this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
    if (existing && (existing.status === 'running' || existing.status === 'paused')) {
      const hint = existing.status === 'paused' ? ' Use resumeDrive to continue.' : '';
      await this.notify(goalChannelId, `Goal "${goalName}" is already ${existing.status}.${hint}`, 'info');
      return existing;
    }

    let baseCwd: string;
    try {
      baseCwd = await resolveMainWorktree(inputCwd);
      if (baseCwd !== inputCwd) {
        logger.info(`[Orchestrator] Normalized baseCwd: ${inputCwd} → ${baseCwd}`);
      }
    } catch (err: any) {
      await this.notify(goalChannelId, `Invalid working directory: ${inputCwd}\nError: ${err.message}`, 'error');
      throw err;
    }

    const goalBranch = await goalNameToBranch(goalName);

    let goalWorktreeDir: string;
    try {
      goalWorktreeDir = await createGoalBranch(baseCwd, goalBranch, this.deps.config.worktreesDir);
    } catch (err: any) {
      await this.notify(goalChannelId, `Failed to create goal branch: ${err.message}`, 'error');
      throw err;
    }

    // 获取 goalMeta（seq + body），全方法共用
    const goalMeta = await this.deps.goalMetaRepo.get(goalId);
    const goalSeq = goalMeta?.seq ?? 0;

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
      tasks: parseTasks(rawTasks),
    };

    // 从 Goal body 解析详细计划，一次性附加到 task 上
    if (goalMeta?.body) {
      const plans = parseTaskDetailPlans(goalMeta.body);
      for (const task of state.tasks) {
        const plan = plans.get(task.id);
        if (plan) {
          task.detailPlan = formatDetailPlanForPrompt(plan);
        }
      }
    }

    // 创建审核员专用 channel（与 goal channel 同一 Category 下）
    const guildId = this.getGuildId();
    if (guildId) {
      try {
        const categoryId = await this.findCategoryId(goalChannelId);
        if (categoryId) {
          const guild = await this.deps.client.guilds.fetch(guildId);
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

    await this.saveState(state);
    this.activeDrives.set(goalId, state);
    await this.syncGoalMetaStatus(goalId, 'Processing');

    // 为审核员 channel 创建 Opus 会话并发送初始化 prompt
    if (guildId) {
      this.ensureGoalChannelSession(state, guildId);
      const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;
      const initPrompt = this.deps.promptService.render('orchestrator.reviewer_init', {
        GOAL_NAME: goalName,
        GOAL_BRANCH: goalBranch,
        TASK_COUNT: String(state.tasks.length),
      });
      try {
        await this.deps.messageHandler.handleBackgroundChat(guildId, reviewerChannelId, initPrompt);
      } catch (err: any) {
        logger.warn(`[Orchestrator] Failed to send reviewer init prompt: ${err.message}`);
      }
    }

    await this.notify(goalChannelId,
      `**Goal Drive started:** ${goalName}\n` +
      `Branch: \`${goalBranch}\`\n` +
      `Tasks: ${state.tasks.length}\n` +
      `Max concurrent: ${maxConcurrent}` +
      (state.reviewerChannelId ? `\nReviewer: <#${state.reviewerChannelId}>` : ''),
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
    await this.notify(state.goalChannelId, `Goal "${state.goalName}" paused`, 'warning');
    return true;
  }

  async resumeDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'paused') return false;
    state.status = 'running';
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Goal "${state.goalName}" resumed`, 'success');

    // 确保 reviewer session 存在（Bot 重启后 paused drive 不经过 restoreRunningDrives）
    const guildId = this.getGuildId();
    if (guildId) {
      this.ensureGoalChannelSession(state, guildId);
    }

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
    if (task.status === 'paused' && task.channelId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'skipped';
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Skipped task: ${this.getTaskLabel(state, task.id)} - ${task.description}`, 'info');
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
    await this.notify(state.goalChannelId, `Manual task completed: ${this.getTaskLabel(state, task.id)} - ${task.description}`, 'success');
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
    if (task.status === 'paused' && task.channelId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        this.deps.claudeClient.abort(lockKey);
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
    // 清除旧事件，防止 check-in 监工误判新一轮执行已上报
    this.deps.taskEventRepo.clearByTask(taskId);
    this.clearCheckInState(taskId);
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Retrying task: ${this.getTaskLabel(state, task.id)} - ${task.description}`, 'warning');
    if (state.status === 'running') await this.reviewAndDispatch(state);
    return true;
  }

  /**
   * 轻量重试：保留 branch/thread 上下文，从 audit 阶段重新开始修复
   * 适用于 audit fix 耗尽但代码本身大部分完成的场景
   */
  async refixTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    // refix 只对 failed 且有 threadId 的任务有效（即有代码上下文）
    if (task.status !== 'failed' || !task.channelId) return false;

    const guildId = this.getGuildId();
    if (!guildId) return false;

    // 中止可能残留的进程
    const lockKey = StateManager.channelLockKey(guildId, task.channelId);
    this.deps.claudeClient.abort(lockKey);

    // 保留 branch/thread/dispatchedAt，重置状态
    task.status = 'running';
    task.error = undefined;
    task.pipelinePhase = 'execute';
    task.auditRetries = (task.auditRetries ?? 0) + 1;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
      `Refixing task: ${this.getTaskLabel(state, task.id)} - ${task.description}`,
      'warning',
    );

    // 重新执行 pipeline（在已有 thread 中继续）
    this.executeTaskPipeline(goalId, taskId, guildId, task.channelId, task, state);
    return true;
  }

  /**
   * 从失败任务触发重规划
   */
  async replanFromTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'failed') return false;

    await this.notify(state.goalChannelId,
      `Triggering replan from task ${this.getTaskLabel(state, task.id)}...`,
      'info',
    );

    // 跳过失败任务
    task.status = 'skipped';
    await this.saveState(state);

    await this.triggerReplan(state, taskId, {
      type: 'replan',
      reason: `User requested replan after task ${task.id} failed: ${task.error ?? 'unknown error'}`,
    });

    const refreshed = await this.getState(goalId);
    if (refreshed?.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
    return true;
  }

  // ========== Feedback 智能调查 ==========

  /**
   * 启动 AI 调查 blocked/clarify feedback
   *
   * 流程：
   * 1. 在已有 thread 中发送调查 prompt（Sonnet 快速分析）
   * 2. Claude 分析 blocked 原因、检查依赖状态/代码上下文
   * 3. 调用 bot_task_event MCP 写结论（task.feedback 事件）
   * 4. 根据结论自动路由：continue（继续修复）/ retry / replan / escalate
   */
  private startFeedbackInvestigation(
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
        const { pipelineSonnetModel: sonnetModel } = this.deps.config;
        this.switchSessionModel(guildId, channelId, sonnetModel, 'execute');
        await this.updatePipelinePhase(goalId, taskId, 'execute');

        await this.notify(state.goalChannelId,
          `[GoalOrchestrator] ${taskId}: AI 调查 blocked feedback...`,
          'pipeline',
        );

        const prompt = this.buildFeedbackInvestigationPrompt(task, state);
        logger.info(`[Orchestrator] Pipeline ${taskId}: feedback investigation started`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, prompt);

        // 读取调查结论
        const conclusion = await this.readInvestigationResult(state, task);
        logger.info(`[Orchestrator] Pipeline ${taskId}: investigation conclusion = ${conclusion.action}`);

        if (!await this.isTaskStillRunning(goalId, taskId)) return;

        switch (conclusion.action) {
          case 'continue':
            // Claude 已在调查中修复了问题 → 走 audit → fix 循环验证
            await this.notify(state.goalChannelId,
              `[GoalOrchestrator] ${taskId}: 调查结论 — 问题已修复，继续执行`,
              'info',
              { logOnly: true },
            );
            // 调查中已修复 → 重新执行 pipeline 让 Claude 确认并上报完成
            this.executeTaskPipeline(goalId, taskId, guildId, channelId, task, state);
            break;

          case 'retry':
            // 需要完全重试
            await this.notify(state.goalChannelId,
              `[GoalOrchestrator] ${taskId}: 调查结论 — 需要完全重试\n原因: ${conclusion.reason}`,
              'warning',
              { logOnly: true },
            );
            await this.withStateLock(goalId, async () => {
              const freshState = await this.getState(goalId);
              if (!freshState) return;
              const freshTask = freshState.tasks.find(t => t.id === taskId);
              if (!freshTask) return;
              // retryTask 要求 failed 状态，先改回 failed 再调用
              freshTask.status = 'failed';
              await this.saveState(freshState);
            });
            await this.retryTask(goalId, taskId);
            break;

          case 'replan':
            // 需要重新规划
            await this.notify(state.goalChannelId,
              `[GoalOrchestrator] ${taskId}: 调查结论 — 需要重新规划\n原因: ${conclusion.reason}`,
              'info',
              { logOnly: true },
            );
            await this.withStateLock(goalId, async () => {
              const freshState = await this.getState(goalId);
              if (!freshState) return;
              const freshTask = freshState.tasks.find(t => t.id === taskId);
              if (!freshTask) return;
              freshTask.status = 'completed';
              freshTask.completedAt = Date.now();
              await this.saveState(freshState);
              await this.triggerReplan(freshState, taskId, {
                type: 'replan',
                reason: conclusion.reason,
                details: conclusion.details,
              });
              const refreshed = await this.getState(goalId);
              if (refreshed && refreshed.status === 'running') {
                await this.reviewAndDispatch(refreshed, taskId);
              }
            });
            break;

          case 'escalate':
          default:
            // 无法自动解决，交给用户
            await this.withStateLock(goalId, async () => {
              const freshState = await this.getState(goalId);
              if (!freshState) return;
              const freshTask = freshState.tasks.find(t => t.id === taskId);
              if (!freshTask) return;
              freshTask.status = 'blocked_feedback';
              freshTask.pipelinePhase = undefined;
              await this.saveState(freshState);
              await this.notify(freshState.goalChannelId,
                `[GoalOrchestrator] ${taskId}: AI 调查无法自动解决\n原因: ${conclusion.reason}\n需要人工干预。`,
                'error',
                { logOnly: true },
              );
            });
            break;
        }
      } catch (err: any) {
        const stillRunning = await this.isTaskStillRunning(goalId, taskId);
        if (!stillRunning) return;
        logger.error(`[Orchestrator] Feedback investigation failed for ${taskId}:`, err.message);
        // 调查本身失败 → 回到 blocked_feedback 等用户处理
        try {
          await this.withStateLock(goalId, async () => {
            const freshState = await this.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            freshTask.status = 'blocked_feedback';
            freshTask.pipelinePhase = undefined;
            await this.saveState(freshState);
            await this.notify(freshState.goalChannelId,
              `[GoalOrchestrator] ${taskId}: AI 调查出错: ${err.message}\n已回退到 blocked_feedback，需要人工干预。`,
              'error',
              { logOnly: true },
            );
          });
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] startFeedbackInvestigation cleanup also failed:`, cbErr.message);
        }
      }
    })();
  }

  /**
   * 构建 feedback 调查 prompt
   */
  private buildFeedbackInvestigationPrompt(task: GoalTask, state: GoalDriveState): string {
    const fb = task.feedback!;
    const label = this.getTaskLabel(state, task.id);

    return `Task ${label} reported feedback and needs investigation.

## Task
Description: ${task.description}
Goal branch: ${state.goalBranch}

## Feedback
Type: ${fb.type}
Reason: ${fb.reason}
${fb.details ? `Details: ${fb.details}` : ''}

## Your Job
Investigate the feedback, check the codebase, and determine the best action:
- **continue**: The issue can be resolved in the current context — fix it and continue
- **retry**: The task needs a fresh start
- **replan**: The feedback reveals a structural issue requiring task plan changes
- **escalate**: Cannot determine the right action — needs human judgment

Call \`bot_task_event\` with:
- \`task_id\`: "${task.id}"
- \`event_type\`: "task.feedback"
- \`payload\`: \`{ "action": "continue|retry|replan|escalate", "reason": "..." }\``;
  }

  /**
   * 读取调查结论事件 task.feedback
   */
  private async readInvestigationResult(
    _state: GoalDriveState,
    task: GoalTask,
  ): Promise<{ action: string; reason: string; details?: string }> {
    const defaultResult = { action: 'escalate', reason: 'No investigation event found in DB' };

    const result = this.deps.taskEventRepo.read<{ action: string; reason: string; details?: string }>(
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

  /**
   * 获取 goal channel 所在的 Category ID（从 channel 向上查找）
   */
  private async findCategoryId(goalChannelId: string): Promise<string | null> {
    try {
      let channel = await this.deps.client.channels.fetch(goalChannelId);
      for (let i = 0; i < 3 && channel; i++) {
        if (channel.type === ChannelType.GuildCategory) {
          return channel.id;
        }
        if ('parentId' in channel && channel.parentId) {
          channel = await this.deps.client.channels.fetch(channel.parentId);
        } else {
          break;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 获取 goal worktree 目录
   */
  private async getGoalWorktreeDir(state: GoalDriveState): Promise<string | null> {
    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `getGoalWorktreeDir: list worktrees`,
      );
      return this.findWorktreeDir(stdout, state.goalBranch);
    } catch {
      return null;
    }
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
    if (task.channelId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'paused';
    // 保留 branchName, threadId, dispatchedAt — 恢复时复用
    await this.saveState(state);
    await this.notify(state.goalChannelId,
      `Paused task: ${this.getTaskLabel(state, task.id)} - ${task.description}\nBranch/thread preserved for resume.`,
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
    if (task.channelId && task.branchName) {
      task.status = 'running';
      await this.saveState(state);
      await this.notify(state.goalChannelId,
        `Resumed task: ${this.getTaskLabel(state, task.id)} - ${task.description}`,
        'success'
      );

      const taskPrompt = `[Resumed] Continue working on this task. Your previous progress has been preserved.\n\n` +
        this.buildTaskPrompt(task, state);
      this.executeTaskInBackground(state.goalId, task.id, guildId, task.channelId, taskPrompt);
      return true;
    }

    // 没有保留上下文 → 重置为 pending，重新派发
    task.status = 'pending';
    task.branchName = undefined;
    task.channelId = undefined;
    task.dispatchedAt = undefined;
    await this.saveState(state);
    await this.notify(state.goalChannelId,
      `Resumed task: ${this.getTaskLabel(state, task.id)} - ${task.description} (re-dispatch)`,
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
        await this.notify(state.goalChannelId,
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
      if (stateModified) await this.saveState(state);

      this.activeDrives.set(state.goalId, state);

      // 恢复 reviewer channel session（确保 cwd 和 Opus 模型正确设置）
      const guildId = this.getGuildId();
      if (guildId) {
        this.ensureGoalChannelSession(state, guildId);
      }

      logger.info(`[Orchestrator] Restored drive: ${state.goalName} (${state.goalId})`);
      await this.reviewAndDispatch(state);
    }
    if (states.length > 0) {
      logger.info(`[Orchestrator] Restored ${states.length} running drives`);
    }

    // 启动后台事件扫描器（兜底：处理 crash 后遗留的未处理事件）
    this.startEventScanner();
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
    // 查看待分发队列中是否有占位任务变为可达状态（前一阶段已完成）
    const pendingPlaceholders = state.tasks.filter(t => {
      if (t.status !== 'pending' || t.type !== '占位') return false;
      const phase = getPhaseNumber(t);
      return phase <= 1 || isPhaseFullyMerged(state, phase - 1);
    });
    if (pendingPlaceholders.length > 0) {
      const placeholderIds = pendingPlaceholders.map(t => t.id).join(', ');
      logger.info(`[Orchestrator] Placeholder tasks ready: ${placeholderIds} — forcing replan`);
      await this.notify(state.goalChannelId,
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
        await this.notify(state.goalChannelId,
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
        case 'clarify': {
          // blocked/clarify：如果有 thread 上下文，启动 AI 调查
          if (task.channelId) {
            const guildId = this.getGuildId();
            if (guildId) {
              task.status = 'running';
              task.pipelinePhase = 'execute';
              await this.saveState(state);
              this.startFeedbackInvestigation(state, task, guildId);
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
      await this.syncGoalMeta(state);

      // 检查未完成的 todo
      let todoWarning = '';
      try {
        const unfinished = await this.deps.goalTodoRepo.findUndoneByGoal(state.goalId);
        if (unfinished.length > 0) {
          todoWarning = `\n\n**Unfinished todos (${unfinished.length}):**\n` +
            unfinished.map(t => `- ${t.content}`).join('\n');
        }
      } catch (err: any) {
        logger.warn(`[Orchestrator] Failed to fetch goal todos: ${err.message}`);
      }

      await this.notify(state.goalChannelId,
        `**Goal "${state.goalName}" completed!**\n` +
        `Review branch \`${state.goalBranch}\` and merge to main.` +
        todoWarning,
        'success'
      );
      return;
    }

    if (isGoalStuck(state)) {
      await this.syncGoalMeta(state);
      await this.notify(state.goalChannelId,
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
        await this.notify(state.goalChannelId,
          `Manual task pending: ${this.getTaskLabel(state, task.id)} - ${task.description}\nReply "done ${task.id}" when complete.`,
          'warning'
        );
      }
    }

    await this.saveState(state);

    for (const task of batch) {
      await this.dispatchTask(state, task);
    }

    // dispatch 后同步 Goal 元数据，确保 next 反映新启动的任务
    await this.syncGoalMeta(state);
  }

  private async dispatchTask(state: GoalDriveState, task: GoalTask): Promise<void> {
    const branchName = await this.generateBranchName(task, state);
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

      const categoryId = await this.findCategoryId(state.goalChannelId);

      if (!categoryId) {
        throw new Error('Cannot find Category for goal channel');
      }

      const guild = await this.deps.client.guilds.fetch(guildId);
      const title = await generateTopicTitle(task.description);
      const taskLabel = this.getTaskLabel(state, task.id);
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

      this.deps.stateManager.getOrCreateSession(guildId, newThreadId, {
        name: channelName,
        cwd: subtaskDir,
      });
      this.deps.stateManager.setSessionForkInfo(guildId, newThreadId, state.goalChannelId, branchName);

      task.channelId = newThreadId;
      task.status = 'running';
      await this.saveState(state);

      await this.notify(state.goalChannelId,
        `Dispatched: ${taskLabel} - ${task.description} → \`${branchName}\``,
        'info'
      );

      this.executeTaskPipeline(state.goalId, task.id, guildId, newThreadId, task, state);

    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      await this.saveState(state);
      await this.notify(state.goalChannelId,
        `Dispatch failed: ${this.getTaskLabel(state, task.id)} - ${task.description}\nError: ${err.message}`,
        'error'
      );
    }
  }

  // ========== Usage 累加辅助 ==========

  private emptyUsage(): ChatUsageResult {
    return {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      total_cost_usd: 0, duration_ms: 0,
    };
  }

  private accumulateUsage(total: ChatUsageResult, single: ChatUsageResult): void {
    total.input_tokens += single.input_tokens;
    total.output_tokens += single.output_tokens;
    total.cache_read_input_tokens += single.cache_read_input_tokens;
    total.cache_creation_input_tokens += single.cache_creation_input_tokens;
    total.total_cost_usd += single.total_cost_usd;
    total.duration_ms += single.duration_ms;
  }

  private executeTaskInBackground(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    message: string
  ): void {
    (async () => {
      const usage = this.emptyUsage();
      try {
        logger.info(`[Orchestrator] Task ${taskId} executing in channel ${channelId}`);
        const u = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, message);
        this.accumulateUsage(usage, u);
        logger.info(`[Orchestrator] Task ${taskId} completed`);
        await this.onTaskCompleted(goalId, taskId, usage);
      } catch (err: any) {
        logger.error(`[Orchestrator] Task ${taskId} failed:`, err.message);
        try {
          await this.onTaskFailed(goalId, taskId, err.message, usage);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr.message);
        }
      }
    })();
  }

  // ========== 多模型流水线 ==========

  /**
   * 切换 session 到新模型，智能复用已有 session
   * 设置 session 模型
   */
  private switchSessionModel(
    guildId: string,
    channelId: string,
    model: string,
    _phase?: PipelinePhase
  ): void {
    this.deps.stateManager.clearSessionClaudeId(guildId, channelId);
    this.deps.stateManager.setSessionModel(guildId, channelId, model);
  }

  private async updatePipelinePhase(goalId: string, taskId: string, phase: PipelinePhase): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.pipelinePhase = phase;
      await this.saveState(state);
    });
  }

  /**
   * 检查任务当前是否仍在 running 状态（防止 pipeline 操作过期引用）
   * 在 pipeline 各 phase 之间调用，如果任务已被外部修改（skip/cancel/retry），中止 pipeline
   */
  private async isTaskStillRunning(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    return task?.status === 'running';
  }

  private async getTaskStatus(goalId: string, taskId: string): Promise<string> {
    const state = await this.getState(goalId);
    if (!state) return 'unknown';
    const task = state.tasks.find(t => t.id === taskId);
    return task?.status ?? 'unknown';
  }

  /**
   * 流水线路由 — 根据 task.type + task.complexity 分发到对应路径
   */
  private executeTaskPipeline(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
  ): void {
    const usage = this.emptyUsage();
    (async () => {
      try {
        // 统一 pipeline：单次执行，Claude 自驱动
        const model = task.type === '调研'
          ? this.deps.config.pipelineOpusModel
          : this.deps.config.pipelineSonnetModel;
        this.switchSessionModel(guildId, channelId, model, 'execute');
        await this.updatePipelinePhase(goalId, taskId, 'execute');

        await this.notify(state.goalChannelId,
          `[GoalOrchestrator] ${taskId}: ${task.type === '调研' ? 'Opus' : 'Sonnet'} 执行`,
          'pipeline',
        );

        const taskPrompt = this.buildTaskPrompt(task, state);
        logger.info(`[Orchestrator] Pipeline ${taskId}: ${task.type} → single execute`);
        const u = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, taskPrompt);
        this.accumulateUsage(usage, u);

        if (!await this.isTaskStillRunning(goalId, taskId)) {
          logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running after execute, aborting`);
          return;
        }

        // Claude 应已通过 bot_task_event 上报 task.completed 或 task.feedback
        // 事件扫描器会处理，这里作为 fallback 直接调用
        await this.onTaskCompleted(goalId, taskId, usage);
      } catch (err: any) {
        logger.error(`[Orchestrator] Pipeline ${taskId} failed:`, err.message);
        const stillRunning = await this.isTaskStillRunning(goalId, taskId);
        if (!stillRunning) {
          logger.info(`[Orchestrator] Pipeline ${taskId}: task already ${await this.getTaskStatus(goalId, taskId)}, skipping onTaskFailed`);
          return;
        }
        try {
          await this.onTaskFailed(goalId, taskId, err.message, usage);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr.message);
        }
      }
    })();
  }



  private async onTaskCompleted(goalId: string, taskId: string, usage?: ChatUsageResult): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      // 防止扫描器与正常流竞争时重复处理同一任务
      if (task.status !== 'running') return;

      // 清除 check-in 追踪
      this.clearCheckInState(taskId);

      // 写入 usage 数据
      if (usage) {
        task.tokensIn = usage.input_tokens;
        task.tokensOut = usage.output_tokens;
        task.cacheReadIn = usage.cache_read_input_tokens;
        task.cacheWriteIn = usage.cache_creation_input_tokens;
        task.costUsd = usage.total_cost_usd;
        task.durationMs = usage.duration_ms;
      }

      // 检测 feedback 文件：worktree/feedback/<taskId>.json
      const feedback = await this.checkFeedbackFile(state, task);
      if (feedback) {
        task.feedback = feedback;

        // replan 类型的 feedback → 自动触发重规划 + 分级自治
        if (feedback.type === 'replan') {
          task.status = 'completed';
          task.completedAt = Date.now();
          await this.saveState(state);

          await this.notify(state.goalChannelId,
            `**Replan feedback:** ${this.getTaskLabel(state, task.id)} - ${task.description}\n` +
            `Reason: ${feedback.reason}`,
            'info'
          );

          // 先 merge 分支，再 replan（replan 需要基于已合并的代码状态）
          if (task.branchName) await this.mergeAndCleanup(state, task);

          // 触发重规划 + 分级自治
          await this.triggerReplan(state, task.id, feedback);

          // replan 后刷新 state 再继续调度
          const refreshed = await this.getState(goalId);
          if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
          return;
        }

        // 非 replan 类型 → 标记为 blocked_feedback 等待人工处理
        task.status = 'blocked_feedback';
        await this.saveState(state);
        await this.notify(state.goalChannelId,
          `**Feedback received:** ${this.getTaskLabel(state, task.id)} - ${task.description}\n` +
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

      const costInfo = usage ? ` ($${usage.total_cost_usd.toFixed(4)}, ${Math.round(usage.duration_ms / 1000)}s)` : '';
      await this.notify(state.goalChannelId, `Completed: ${this.getTaskLabel(state, task.id)} - ${task.description}${costInfo}`, 'success');

      // Phase Review: 不立即 merge，先触发 per-task 审核
      const guildId = this.getGuildId();
      if (guildId && task.branchName) {
        this.triggerTaskReview(state, task, guildId);
      } else {
        // 无分支（调研等）→ 直接 merge/dispatch
        if (task.branchName) await this.mergeAndCleanup(state, task);
        const refreshed = await this.getState(goalId);
        if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
      }
    });
  }

  async onTaskFailed(goalId: string, taskId: string, error: string, usage?: ChatUsageResult): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      // 清除 check-in 追踪
      this.clearCheckInState(taskId);

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

      await this.saveState(state);

      const costInfo = usage ? ` ($${usage.total_cost_usd.toFixed(4)})` : '';
      const hasContext = !!task.channelId;

      const hint = hasContext
        ? `Reply "retry ${task.id}" to restart, or "refix ${task.id}" to fix in-place.`
        : `Reply "retry ${task.id}" to retry.`;
      const buttons = hasContext
        ? buildTaskFailedButtons(goalId, task.id)
        : undefined;
      await this.notify(state.goalChannelId,
        `Failed: ${this.getTaskLabel(state, task.id)} - ${task.description}${costInfo}\nError: ${error}\n\n${hint}`,
        'error',
        buttons ? { components: buttons } : undefined,
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

      // 调用 LLM replan
      const ctx: ReplanContext = {
        state,
        goalMeta,
        triggerTaskId,
        feedback,
        completedDiffStats,
        promptService: this.deps.promptService,
      };
      const result = await replanTasks(ctx);

      if (!result) {
        await this.notify(state.goalChannelId,
          `Replan 调用失败 — LLM 未返回有效结果，当前计划保持不变`,
          'warning',
        );
        return;
      }
      if (result.changes.length === 0) {
        await this.notify(state.goalChannelId,
          `Replan: 无需变更 — ${result.reasoning}`,
          'info',
        );
        return;
      }

      // 4. 分级自治处理
      const handleResult = await handleReplanByImpact(state, result, {
        taskRepo: this.deps.taskRepo,
        goalMetaRepo: this.deps.goalMetaRepo,
        checkpointRepo: this.deps.checkpointRepo,
        notify: (threadId, message, type, options) => this.notify(threadId, message, type, options),
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
      logger.error(`[Orchestrator] triggerReplan failed: ${err.message}`);
      await this.notify(state.goalChannelId,
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
      await this.notify(state.goalChannelId, '没有待审批的计划变更', 'info');
      return false;
    }

    const pending = state.pendingReplan;

    // 应用变更
    const applyResult = await applyChanges(state, pending.changes as ReplanChange[], {
      taskRepo: this.deps.taskRepo,
      goalMetaRepo: this.deps.goalMetaRepo,
    });

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
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
      taskRepo: this.deps.taskRepo,
      goalMetaRepo: this.deps.goalMetaRepo,
    });

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
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
      await this.notify(state.goalChannelId, '没有待审批的计划变更', 'info');
      return false;
    }

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
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
        await this.notify(state.goalChannelId,
          `已有待确认的回滚操作（检查点: \`${state.pendingRollback.checkpointId}\`）\n` +
          `请先 \`confirm rollback\` 或 \`cancel rollback\``,
          'warning',
        );
        return null;
      }

      // 1. 加载检查点
      const checkpoint = await this.deps.checkpointRepo.get(checkpointId);
      if (!checkpoint) {
        await this.notify(state.goalChannelId, `检查点 \`${checkpointId}\` 不存在`, 'error');
        return null;
      }
      if (checkpoint.goalId !== goalId) {
        await this.notify(state.goalChannelId, `检查点 \`${checkpointId}\` 不属于此 Goal`, 'error');
        return null;
      }
      if (!checkpoint.tasksSnapshot) {
        await this.notify(state.goalChannelId, `检查点 \`${checkpointId}\` 没有任务快照`, 'error');
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
          if (task.channelId && guildId) {
            const lockKey = StateManager.channelLockKey(guildId, task.channelId);
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

      await this.notify(state.goalChannelId, confirmMessage, 'warning', {
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
        await this.notify(state.goalChannelId, '没有待确认的回滚操作', 'info');
        return false;
      }

      const guildId = this.getGuildId();

      // 1. 恢复检查点的任务快照
      const snapshotTasks = await this.deps.checkpointRepo.restoreCheckpoint(pending.checkpointId);
      if (!snapshotTasks) {
        await this.notify(state.goalChannelId,
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
      const worktreeListOutput = await this.safeListWorktrees(state.baseCwd);

      for (const task of tasksToCleanup) {
        // 停止进程
        if (task.channelId && guildId) {
          const lockKey = StateManager.channelLockKey(guildId, task.channelId);
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
        if (task.channelId) {
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'rollback');
          }
          try {
            const channel = await this.deps.client.channels.fetch(task.channelId);
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
            await this.notify(state.goalChannelId,
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
      await this.deps.taskRepo.saveAll(snapshotTasks, state.goalId);
      await this.saveState(state);

      // 更新 Goal body
      const goalMeta = await this.deps.goalMetaRepo.get(state.goalId);
      if (goalMeta) {
        goalMeta.body = updateGoalBodyWithTasks(goalMeta.body, snapshotTasks);
        const total = snapshotTasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
        const completed = snapshotTasks.filter(t => t.status === 'completed' && (!t.branchName || t.merged)).length;
        const running = snapshotTasks.filter(t => t.status === 'dispatched' || t.status === 'running').length;
        const failed = snapshotTasks.filter(t => t.status === 'failed').length;
        goalMeta.progress = JSON.stringify({ completed, total, running, failed });
        await this.deps.goalMetaRepo.save(goalMeta);
      }

      const cleanedCount = tasksToCleanup.length;
      await this.notify(state.goalChannelId,
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
        await this.notify(state.goalChannelId, '没有待确认的回滚操作', 'info');
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
          task.channelId = undefined;
          task.dispatchedAt = undefined;
        }
      }

      delete state.pendingRollback;
      await this.saveState(state);

      await this.notify(state.goalChannelId,
        `🚫 **回滚已取消**\n已暂停的任务将重新派发（之前的执行进度无法恢复）`,
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
   * 检测任务的 task.feedback 事件（从 DB 读取）
   */
  private async checkFeedbackFile(_state: GoalDriveState, task: GoalTask): Promise<GoalTaskFeedback | null> {
    const parsed = this.deps.taskEventRepo.read<{
      type?: string;
      reason?: string;
      details?: string;
    }>(task.id, 'task.feedback');

    if (!parsed || !parsed.type || !parsed.reason) return null;

    return {
      type: parsed.type,
      reason: parsed.reason,
      details: parsed.details,
    };
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
        await this.notify(state.goalChannelId, `Cannot find goal worktree, skipping merge: ${branchName}`, 'warning');
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
        await this.notify(state.goalChannelId, `Merged: \`${branchName}\` → \`${state.goalBranch}\``, 'success');

        if (subtaskDir) {
          await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
        }

        // Delete subtask channel
        if (task.channelId) {
          const guildId = this.getGuildId();
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'merged');
            try {
              const channel = await this.deps.client.channels.fetch(task.channelId);
              if (channel && 'delete' in channel) {
                await (channel as any).delete('Task merged and cleaned up').catch(() => {});
              }
            } catch { /* ignore */ }
          }
        }
      } else if (result.conflict) {
        // 尝试 AI 自动解决冲突
        await this.notify(state.goalChannelId,
          `Merge conflict: \`${branchName}\` → \`${state.goalBranch}\`, trying AI resolution...`,
          'warning'
        );

        const resolution = await resolveConflictsWithAI(
          this.deps.claudeClient,
          goalWorktreeDir,
          branchName,
          task.description,
          this.deps.promptService,
        );

        if (resolution.resolved) {
          task.merged = true;
          await this.saveState(state);
          await this.notify(state.goalChannelId,
            `AI resolved conflict and merged: \`${branchName}\` → \`${state.goalBranch}\``,
            'success'
          );

          if (subtaskDir) {
            await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
          }

          if (task.channelId) {
            const guildId = this.getGuildId();
            if (guildId) {
              this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'merged');
              try {
                const channel = await this.deps.client.channels.fetch(task.channelId);
                if (channel && 'delete' in channel) {
                  await (channel as any).delete('Task merged and cleaned up').catch(() => {});
                }
              } catch { /* ignore */ }
            }
          }
        } else {
          // AI 无法解决 → 写 merge.conflict 事件，由 reviewer 排队处理
          await this.notify(state.goalChannelId,
            `AI could not resolve conflict: \`${branchName}\` → \`${state.goalBranch}\`\n` +
            `Reason: ${resolution.error}\nQueued for reviewer...`,
            'warning'
          );
          this.deps.taskEventRepo.write(task.id, state.goalId, 'merge.conflict', {
            branchName,
            goalWorktreeDir,
            subtaskDir: subtaskDir ?? null,
            taskDescription: task.description,
            error: resolution.error ?? 'unknown',
          }, 'orchestrator');
          // task 保持 completed 状态（execution done，merge pending）
          await this.saveState(state);
        }
      } else {
        await this.notify(state.goalChannelId, `Merge failed: ${branchName}\nError: ${result.error}`, 'error');
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] mergeAndCleanup error: ${err.message}`);
    }
  }

  private async generateBranchName(task: GoalTask, state: GoalDriveState): Promise<string> {
    const prefix = task.type === '调研' ? 'research' : 'feat';
    const translated = await translateToBranchName(task.description);
    const taskLabel = this.getTaskLabel(state, task.id);
    return `${prefix}/${taskLabel}-${translated.slice(0, 30) || 'task'}`;
  }

  private buildTaskPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const parts: string[] = [];

    // 主模板
    parts.push(ps.render('orchestrator.task', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_TYPE: task.type,
      TASK_DESCRIPTION: task.description,
    }));

    // 条件 section：详细计划
    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.task.detail_plan', {
        DETAIL_PLAN_TEXT: task.detailPlan,
      });
      if (s) parts.push(s);
    }

    // 固定 sections（tryRender 容错）
    const req = ps.tryRender('orchestrator.task.requirements', {});
    if (req) parts.push(req);
    const fb = ps.tryRender('orchestrator.task.feedback_protocol', { TASK_ID: task.id });
    if (fb) parts.push(fb);

    // 条件 section：调研任务
    if (task.type === '调研') {
      const s = ps.tryRender('orchestrator.task.research_rules', { TASK_ID: task.id });
      if (s) parts.push(s);
    }

    // 条件 section：占位任务
    if (task.type === '占位') {
      const s = ps.tryRender('orchestrator.task.placeholder_rules', {});
      if (s) parts.push(s);
    }

    return parts.join('\n\n');
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

  /**
   * 发送通知到 goal thread 和/或日志 channel
   *
   * type 说明：
   * - success/error/warning/info: 发到 goal thread（同时也发日志 channel）
   * - pipeline: 仅发到日志 channel（如未配置则 fallback 到 goal thread）
   *
   * 颜色映射：
   * - success → GREEN, error → RED, warning → YELLOW, info → GRAY, pipeline → BLUE
   */
  private async notify(
    threadId: string,
    message: string,
    type?: 'success' | 'error' | 'warning' | 'info' | 'pipeline',
    options?: {
      components?: import('discord.js').ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>[];
      logOnly?: boolean;
    },
  ): Promise<void> {
    try {
      const colorMap: Record<string, EmbedColor> = {
        success: EmbedColors.GREEN,
        error: EmbedColors.RED,
        warning: EmbedColors.YELLOW,
        info: EmbedColors.GRAY,
        pipeline: EmbedColors.BLUE,
      };
      const embedColor = type ? colorMap[type] : undefined;
      const logChannelId = getGoalLogChannelId();

      if (type === 'pipeline' || options?.logOnly) {
        // pipeline 类型或 logOnly：仅发日志 channel（未配置则 fallback 到 goal thread）
        const targetId = logChannelId || threadId;
        await this.deps.mq.sendLong(targetId, message, {
          embedColor,
          components: options?.components,
        });
      } else {
        // 其他类型：发到 goal thread
        await this.deps.mq.sendLong(threadId, message, {
          embedColor,
          components: options?.components,
        });
        // 同时发到日志 channel（如已配置，且目标不同）
        if (logChannelId && logChannelId !== threadId) {
          await this.deps.mq.sendLong(logChannelId, message, {
            embedColor,
            silent: true,
          });
        }
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] Failed to send notification: ${err.message}`);
    }
  }

  private getGuildId(): string | null {
    return getAuthorizedGuildId() ?? null;
  }

  // ========== 后台事件扫描器 ==========

  /**
   * 启动后台事件扫描器
   *
   * 每 5s 扫描一次 DB 中未处理的 task_events，
   * 兜底处理 AI session crash 后遗留的事件。
   */
  private startEventScanner(): void {
    const INTERVAL = 5_000;
    const tick = async () => {
      try {
        await this.processPendingEvents();
      } catch (e) {
        logger.error('[Scanner] Error processing pending events:', e);
      }
      try {
        await this.checkOrphanedTasks();
      } catch (e) {
        logger.error('[Scanner] Error checking orphaned tasks:', e);
      }
      setTimeout(tick, INTERVAL);
    };
    setTimeout(tick, INTERVAL);
    logger.info('[Scanner] Event scanner started (5s interval)');
  }

  private async processPendingEvents(): Promise<void> {
    const pending = this.deps.taskEventRepo.findPending();
    if (pending.length === 0) return;

    for (const ev of pending) {
      // 找到对应的 active drive
      if (!ev.goalId) {
        this.deps.taskEventRepo.markProcessed(ev.id);
        continue;
      }

      const state = this.activeDrives.get(ev.goalId);
      if (!state) {
        // goal 不在内存中（可能已完成）— 标记为已处理
        this.deps.taskEventRepo.markProcessed(ev.id);
        continue;
      }

      // 暂停/完成的 goal 不自动处理事件，等 goal 恢复 running 后再处理
      if (state.status !== 'running') continue;

      const task = state.tasks.find(t => t.id === ev.taskId);
      if (!task) {
        this.deps.taskEventRepo.markProcessed(ev.id);
        continue;
      }

      try {
        switch (ev.eventType) {
          case 'task.completed':
          case 'task.feedback':
            // 任务完成/反馈事件 — 只处理 running 状态的任务
            if (task.status !== 'running') {
              this.deps.taskEventRepo.markProcessed(ev.id);
              continue;
            }
            logger.info(`[Scanner] Processing '${ev.eventType}' for task ${ev.taskId}`);
            await this.onTaskCompleted(ev.goalId, ev.taskId);
            break;

          case 'review.task_result':
            // Per-task 审核结果 — 处理 completed 但未 merged 的任务
            if (task.status !== 'completed' || task.merged) {
              this.deps.taskEventRepo.markProcessed(ev.id);
              continue;
            }
            logger.info(`[Scanner] Processing review.task_result for task ${ev.taskId}`);
            await this.handleTaskReviewResult(ev.goalId, ev.taskId, ev.payload as any);
            break;

          case 'review.phase_result':
            // Phase 评估结果
            logger.info(`[Scanner] Processing review.phase_result for task ${ev.taskId}`);
            await this.handlePhaseResult(ev.goalId, ev.taskId, ev.payload as any);
            break;

          case 'merge.conflict': {
            // Merge 冲突等待 reviewer 处理 — reviewer 忙时跳过，下轮再试
            if (task.merged) {
              this.deps.taskEventRepo.markProcessed(ev.id);
              continue;
            }
            const guildId = this.getGuildId();
            if (!guildId) continue; // 未连接 guild，下轮重试
            const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;
            const reviewerLockKey = StateManager.channelLockKey(guildId, reviewerChannelId);
            if (this.deps.claudeClient.isRunning(reviewerLockKey)) {
              continue; // reviewer 忙，不标 processed，下轮重试
            }
            logger.info(`[Scanner] Processing merge.conflict for task ${ev.taskId}`);
            this.triggerConflictReview(state, task, guildId, ev.payload as MergeConflictPayload);
            break;
          }

          case 'review.conflict_result': {
            // Reviewer 已解决冲突，继续 merge 流程
            if (task.merged) {
              this.deps.taskEventRepo.markProcessed(ev.id);
              continue;
            }
            logger.info(`[Scanner] Processing review.conflict_result for task ${ev.taskId}`);
            await this.handleConflictResolutionResult(ev.goalId, ev.taskId, ev.payload as any);
            break;
          }

          default:
            logger.warn(`[Scanner] Unknown event type: ${ev.eventType}`);
        }
        this.deps.taskEventRepo.markProcessed(ev.id);
      } catch (err: any) {
        logger.error(`[Scanner] Failed to process event ${ev.id}: ${err.message}`);
      }
    }
  }

  // ========== Check-in 监工 ==========

  private static readonly CHECK_IN_COOLDOWN = 10 * 60 * 1000;  // 10 分钟
  private static readonly MAX_CHECK_INS = 3;
  private static readonly MAX_REVIEW_RETRIES = 3;

  /**
   * 扫描所有 running 任务，检测 session 已结束但无事件上报的情况。
   * 触发 check-in prompt 催促 AI 汇报状态，超限则标记失败。
   */
  private async checkOrphanedTasks(): Promise<void> {
    const now = Date.now();
    const guildId = this.getGuildId();
    if (!guildId) return;

    for (const state of this.activeDrives.values()) {
      if (state.status !== 'running') continue;

      for (const task of state.tasks) {
        if (task.status !== 'running' || !task.channelId) continue;

        // 检查是否有未处理的事件（scanner 会处理这些，不需要 check-in）
        const hasCompletedEvent = this.deps.taskEventRepo.read(task.id, 'task.completed') !== null;
        const hasFeedbackEvent = this.deps.taskEventRepo.read(task.id, 'task.feedback') !== null;
        if (hasCompletedEvent || hasFeedbackEvent) continue;

        // 检查 session 状态
        const sessionStatus = this.deps.stateManager.getChannelSessionStatus(task.channelId);
        // 只在 session idle 或 closed 时触发 check-in（active/waiting 说明 AI 还在工作）
        if (sessionStatus === 'active' || sessionStatus === 'waiting') continue;
        // 如果 sessionStatus 为 null（无 session 记录），也需要 check-in
        if (sessionStatus !== null && sessionStatus !== 'idle' && sessionStatus !== 'closed') continue;

        // Cooldown 检查
        const lastCheckIn = this.lastCheckInAt.get(task.id) ?? (task.dispatchedAt || 0);
        if (now - lastCheckIn < GoalOrchestrator.CHECK_IN_COOLDOWN) continue;

        const count = this.checkInCounts.get(task.id) ?? 0;
        if (count >= GoalOrchestrator.MAX_CHECK_INS) {
          // 超限 → 标记失败
          logger.warn(`[CheckIn] Task ${task.id} exceeded max check-ins (${GoalOrchestrator.MAX_CHECK_INS}), marking failed`);
          await this.onTaskFailed(state.goalId, task.id, `No response after ${GoalOrchestrator.MAX_CHECK_INS} check-in attempts`);
          this.clearCheckInState(task.id);
          continue;
        }

        // 发送 check-in
        this.sendCheckIn(state, task, guildId, count + 1);
        this.checkInCounts.set(task.id, count + 1);
        this.lastCheckInAt.set(task.id, now);
      }
    }
  }

  /**
   * 向任务 channel 发送 check-in 催促消息。
   * 异步执行，不阻塞扫描器。
   */
  private sendCheckIn(
    state: GoalDriveState,
    task: GoalTask,
    guildId: string,
    attempt: number,
    reviewIssues?: string,
  ): void {
    const taskId = task.id;
    const channelId = task.channelId!;

    (async () => {
      try {
        const ps = this.deps.promptService;
        const prompt = ps.render('orchestrator.check_in', {
          TASK_LABEL: this.getTaskLabel(state, taskId),
          REVIEW_ISSUES: reviewIssues
            ? `\n## Review Issues\nThe following issues were found in a previous review:\n${reviewIssues}`
            : '',
        });

        await this.notify(state.goalChannelId,
          `[GoalOrchestrator] Check-in #${attempt} for ${taskId} (session idle, no event received)`,
          'warning',
        );

        logger.info(`[CheckIn] Sending check-in #${attempt} for task ${taskId}`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, prompt);
      } catch (err: any) {
        logger.error(`[CheckIn] Failed to send check-in for task ${taskId}: ${err.message}`);
      }
    })();
  }

  /** 清除任务的 check-in 追踪状态 */
  private clearCheckInState(taskId: string): void {
    this.checkInCounts.delete(taskId);
    this.lastCheckInAt.delete(taskId);
  }

  // ========== Phase Review ==========

  /**
   * 确保 Goal Channel 有一个 Opus 会话可用于审核。
   * 如果没有 session 则创建一个，模型设为 Opus。
   * 始终更新 cwd（防止 syncFromDiscord 将 cwd 覆盖为 '/default'，
   * 或 Bot 重启后从 DB 重建的 session 携带错误 cwd）。
   */
  private ensureGoalChannelSession(state: GoalDriveState, guildId: string): void {
    const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;
    this.deps.stateManager.getOrCreateSession(guildId, reviewerChannelId, {
      name: `review-${state.goalName}`,
      cwd: state.baseCwd,
    });
    // 始终强制同步正确 cwd 到内存和 DB（getOrCreateSession 只在 session 不存在时写 DB）
    this.deps.stateManager.setSessionCwd(guildId, reviewerChannelId, state.baseCwd);
    this.deps.stateManager.setSessionModel(guildId, reviewerChannelId, this.deps.config.pipelineOpusModel);
  }

  /**
   * 触发 per-task 审核：向 Goal Channel 发送审核消息。
   * 异步执行，不阻塞调用方。
   */
  private triggerTaskReview(state: GoalDriveState, task: GoalTask, guildId: string): void {
    const taskId = task.id;
    const goalChannelId = state.goalChannelId;
    const reviewerChannelId = state.reviewerChannelId ?? goalChannelId;

    (async () => {
      try {
        this.ensureGoalChannelSession(state, guildId);

        // 收集 diff stats
        let diffStats = '(unavailable)';
        try {
          const goalDir = await this.getGoalWorktreeDir(state);
          if (goalDir && task.branchName) {
            diffStats = await execGit(
              ['diff', '--stat', `${state.goalBranch}...${task.branchName}`],
              goalDir,
              `triggerTaskReview: diff stat for ${taskId}`,
            );
          }
        } catch {
          // diff stats 收集失败不影响审核
        }

        const ps = this.deps.promptService;
        const prompt = ps.render('orchestrator.task_review', {
          TASK_LABEL: this.getTaskLabel(state, taskId),
          TASK_DESCRIPTION: task.description,
          BRANCH_NAME: task.branchName ?? '(unknown)',
          DIFF_STATS: diffStats,
          TASK_ID: taskId,
        });

        await this.notify(goalChannelId,
          `[GoalOrchestrator] Reviewing task ${taskId}: ${task.description}`,
          'pipeline',
        );

        logger.info(`[PhaseReview] Triggering per-task review for ${taskId}`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, reviewerChannelId, prompt);

        // Fallback: 如果 AI 没写事件但 session 正常结束，检查事件并处理
        const reviewResult = this.deps.taskEventRepo.read<{
          verdict?: string;
          summary?: string;
          issues?: string[];
        }>(taskId, 'review.task_result');
        if (reviewResult) {
          // 标记已处理，防止 scanner 重复处理
          this.deps.taskEventRepo.markProcessedByTask(taskId, 'review.task_result');
          await this.handleTaskReviewResult(state.goalId, taskId, reviewResult);
        } else {
          // 没写事件 → check-in 机制会处理
          logger.warn(`[PhaseReview] No review.task_result event from review of ${taskId}, check-in will handle`);
        }
      } catch (err: any) {
        // 审核失败 → 自动 pass 以不阻塞流水线
        logger.error(`[PhaseReview] Failed to review task ${taskId}: ${err.message}`);
        await this.handleTaskReviewResult(state.goalId, taskId, {
          verdict: 'pass',
          summary: `Review failed (${err.message}), auto-passing`,
        });
      }
    })();
  }

  /**
   * 处理 per-task 审核结果。
   * verdict=pass → merge → 检查 phase 完成情况
   * verdict=fail → 打回 subtask 修复
   */
  private async handleTaskReviewResult(
    goalId: string,
    taskId: string,
    result: { verdict?: string; summary?: string; issues?: string[] },
  ): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'completed') return;
      // 已经 merged 的不重复处理
      if (task.merged) return;

      if (result.verdict === 'pass') {
        logger.info(`[PhaseReview] Task ${taskId} passed review: ${result.summary}`);
        await this.notify(state.goalChannelId,
          `Review passed: ${this.getTaskLabel(state, taskId)} - ${result.summary || 'OK'}`,
          'success',
        );

        if (task.branchName) await this.mergeAndCleanup(state, task);

        // 检查 phase 是否全部 merged
        const phase = getPhaseNumber(task);
        if (isPhaseFullyMerged(state, phase)) {
          const guildId = this.getGuildId();
          if (guildId) {
            this.triggerPhaseEvaluation(state, phase, guildId);
            return; // phase evaluation 会处理 dispatch
          }
        }

        // 非 phase 边界 → 继续调度
        const refreshed = await this.getState(goalId);
        if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
      } else {
        // fail → 打回 subtask 修复
        const issues = result.issues?.join('\n- ') || result.summary || 'Review failed';
        logger.info(`[PhaseReview] Task ${taskId} failed review: ${issues}`);
        await this.notify(state.goalChannelId,
          `Review failed: ${this.getTaskLabel(state, taskId)}\nIssues: ${issues}`,
          'warning',
        );

        const refixCount = (task.auditRetries ?? 0) + 1;
        if (refixCount > GoalOrchestrator.MAX_REVIEW_RETRIES) {
          // 超限 → 标记失败
          task.status = 'failed';
          task.error = `Review failed after ${refixCount} attempts: ${issues}`;
          await this.saveState(state);
          await this.notify(state.goalChannelId,
            `Task ${this.getTaskLabel(state, taskId)} failed review ${refixCount} times, marking as failed`,
            'error',
          );
          return;
        }

        // 恢复为 running，发送 check-in 带 issues 信息让 subtask 修复
        task.status = 'running';
        task.auditRetries = refixCount;
        await this.saveState(state);

        const guildId = this.getGuildId();
        if (guildId && task.channelId) {
          this.sendCheckIn(state, task, guildId, 1, `- ${issues}`);
        }
      }
    });
  }

  /**
   * 触发冲突解决审核：向 reviewer 发送冲突信息，reviewer 空闲时处理。
   * 异步执行，不阻塞调用方。
   */
  private triggerConflictReview(
    state: GoalDriveState,
    task: GoalTask,
    guildId: string,
    payload: MergeConflictPayload,
  ): void {
    (async () => {
      try {
        this.ensureGoalChannelSession(state, guildId);
        const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;
        const ps = this.deps.promptService;
        const prompt = ps.render('orchestrator.conflict_review', {
          TASK_LABEL: this.getTaskLabel(state, task.id),
          BRANCH_NAME: payload.branchName,
          GOAL_BRANCH: state.goalBranch,
          TASK_DESCRIPTION: payload.taskDescription,
          AI_ERROR: payload.error,
          GOAL_WORKTREE_DIR: payload.goalWorktreeDir,
          TASK_ID: task.id,
        });
        await this.notify(state.goalChannelId,
          `[GoalOrchestrator] Conflict review queued: ${this.getTaskLabel(state, task.id)}`,
          'pipeline',
        );
        await this.deps.messageHandler.handleBackgroundChat(guildId, reviewerChannelId, prompt);
      } catch (err: any) {
        logger.error(`[ConflictReview] Failed to trigger conflict review for ${task.id}: ${err.message}`);
      }
    })();
  }

  /**
   * 处理 reviewer 的冲突解决结果。
   * resolved=true → 标记 merged，清理，继续 pipeline。
   * resolved=false → 设为 blocked，通知人工介入。
   */
  private async handleConflictResolutionResult(
    goalId: string,
    taskId: string,
    result: { resolved: boolean; summary?: string },
  ): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || task.merged) return;

      if (result.resolved) {
        task.merged = true;
        await this.saveState(state);
        await this.notify(state.goalChannelId,
          `Reviewer resolved conflict and merged: ${this.getTaskLabel(state, taskId)} — ${result.summary ?? 'OK'}`,
          'success',
        );

        // 清理 subtask worktree 和分支
        const conflictPayload = this.deps.taskEventRepo.read<MergeConflictPayload>(taskId, 'merge.conflict');
        if (task.branchName && conflictPayload?.subtaskDir) {
          await cleanupSubtask(state.baseCwd, conflictPayload.subtaskDir, task.branchName).catch(() => {});
        }

        // 清理 subtask Discord channel
        if (task.channelId) {
          const guildId = this.getGuildId();
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'merged');
            try {
              const channel = await this.deps.client.channels.fetch(task.channelId);
              if (channel && 'delete' in channel) {
                await (channel as any).delete('Task merged and cleaned up').catch(() => {});
              }
            } catch { /* ignore */ }
          }
        }

        // 检查 phase 是否全部 merged → 触发 phase 评估或继续调度
        const phase = getPhaseNumber(task);
        const guildId = this.getGuildId();
        if (guildId && isPhaseFullyMerged(state, phase)) {
          this.triggerPhaseEvaluation(state, phase, guildId);
          return;
        }
        const refreshed = await this.getState(goalId);
        if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
      } else {
        task.status = 'blocked';
        task.error = `merge conflict (reviewer could not resolve: ${result.summary ?? 'unknown'})`;
        await this.saveState(state);
        await this.notify(state.goalChannelId,
          `Reviewer could not resolve conflict for ${this.getTaskLabel(state, taskId)}: ${result.summary ?? 'unknown'}\nManual resolution needed.`,
          'error',
        );
      }
    });
  }

  /**
   * 触发 Phase 全局评估。
   * 异步执行，不阻塞调用方。
   */
  private triggerPhaseEvaluation(state: GoalDriveState, phase: number, guildId: string): void {
    const goalId = state.goalId;
    const reviewerChannelId = state.reviewerChannelId ?? state.goalChannelId;

    (async () => {
      try {
        this.ensureGoalChannelSession(state, guildId);

        // 收集 phase 内任务审核摘要
        const phaseTasks = state.tasks.filter(t => getPhaseNumber(t) === phase);
        const summaries = phaseTasks.map(t => {
          const status = t.merged ? 'merged' : t.status;
          return `- ${t.id}: ${t.description} [${status}]`;
        }).join('\n');

        const progress = getProgressSummary(state);

        // 用最后一个 merged 任务作为事件锚点
        const lastMerged = phaseTasks.filter(t => t.merged).pop();
        const phaseTaskId = lastMerged?.id ?? phaseTasks[0]?.id ?? 'unknown';

        const ps = this.deps.promptService;
        const prompt = ps.render('orchestrator.phase_review', {
          PHASE_NUMBER: String(phase),
          GOAL_NAME: state.goalName,
          TASK_REVIEW_SUMMARIES: summaries,
          PROGRESS_SUMMARY: progress,
          PHASE_TASK_ID: phaseTaskId,
        });

        await this.notify(state.goalChannelId,
          `[GoalOrchestrator] Phase ${phase} complete — triggering evaluation`,
          'pipeline',
        );

        logger.info(`[PhaseReview] Triggering phase ${phase} evaluation for goal ${goalId}`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, reviewerChannelId, prompt);

        // Fallback: 检查事件
        const phaseResult = this.deps.taskEventRepo.read<{
          decision?: string;
          summary?: string;
          issues?: string[];
        }>(phaseTaskId, 'review.phase_result');
        if (phaseResult) {
          // 标记已处理，防止 scanner 重复处理
          this.deps.taskEventRepo.markProcessedByTask(phaseTaskId, 'review.phase_result');
          await this.handlePhaseResult(goalId, phaseTaskId, phaseResult);
        } else {
          // 没写事件 → 默认 continue
          logger.warn(`[PhaseReview] No review.phase_result event for phase ${phase}, defaulting to continue`);
          await this.handlePhaseResult(goalId, phaseTaskId, { decision: 'continue', summary: 'Auto-continue (no event)' });
        }
      } catch (err: any) {
        // 评估失败 → 默认 continue
        logger.error(`[PhaseReview] Phase ${phase} evaluation failed: ${err.message}`);
        await this.handlePhaseResult(goalId, 'fallback', { decision: 'continue', summary: `Evaluation failed: ${err.message}` });
      }
    })();
  }

  /**
   * 处理 Phase 评估结果。
   * continue → 继续调度下一 phase
   * replan → 触发重规划
   */
  private async handlePhaseResult(
    goalId: string,
    _triggerTaskId: string,
    result: { decision?: string; summary?: string; issues?: string[] },
  ): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state || state.status !== 'running') return;

      if (result.decision === 'replan') {
        logger.info(`[PhaseReview] Phase evaluation recommends replan: ${result.summary}`);
        await this.notify(state.goalChannelId,
          `**Phase evaluation → replan:** ${result.summary}`,
          'warning',
        );

        // 使用 current phase 最后一个任务触发 replan
        const currentPhase = getCurrentPhase(state);
        const phaseTasks = state.tasks.filter(t => getPhaseNumber(t) === currentPhase);
        const triggerTask = phaseTasks[phaseTasks.length - 1];
        if (triggerTask) {
          await this.triggerReplan(state, triggerTask.id, {
            type: 'replan',
            reason: result.summary || 'Phase evaluation recommended replan',
            details: result.issues?.join('; '),
          });
        }

        const refreshed = await this.getState(goalId);
        if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed);
      } else {
        // continue
        logger.info(`[PhaseReview] Phase evaluation: continue — ${result.summary}`);
        await this.notify(state.goalChannelId,
          `**Phase evaluation → continue:** ${result.summary || 'OK'}`,
          'success',
        );
        await this.reviewAndDispatch(state);
      }
    });
  }
}
