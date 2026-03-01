/**
 * GoalOrchestrator — Goal 自动调度引擎（Discord 版）
 *
 * 负责：
 * 1. 启动 Goal drive（创建 goal 分支 + Category Text Channel）
 * 2. 自动派发子任务到独立 worktree/Text Channel
 * 3. 监控子任务完成 → 自动 merge 到 goal 分支
 * 4. 全程通知用户，异常时暂停等待干预
 *
 * 实现分散在多个 handler 文件中，本文件为 facade + 核心工具方法。
 */

import { ChannelType } from 'discord.js';
import { EmbedColors, type EmbedColor } from '../bot/message-queue.js';
import type { GoalDriveState, GoalTask, GoalTaskFeedback, PipelinePhase, PendingRollback, ChatUsageResult } from '../types/index.js';
import { ClaudeErrorType, ClaudeExecutionError } from '../types/index.js';
import { getAuthorizedGuildId, getGoalLogChannelId } from '../utils/env.js';
import { execGit } from './git-ops.js';
import { translateToBranchName } from './goal-state.js';
import { isGoalComplete, isGoalStuck, getProgressSummary } from './task-scheduler.js';
import { logger } from '../utils/logger.js';

// Types re-export (external callers import from here)
import type { OrchestratorDeps, NotifyOptions, NotifyType } from './orchestrator-types.js';
export type { StartDriveParams } from './orchestrator-types.js';

// Handler imports
import {
  startDrive as _startDrive,
  pauseDrive as _pauseDrive,
  pauseAllRunningDrives as _pauseAllRunningDrives,
  resumeDrive as _resumeDrive,
  getStatus as _getStatus,
  restoreRunningDrives as _restoreRunningDrives,
} from './drive.js';
import {
  skipTask as _skipTask,
  markTaskDone as _markTaskDone,
  retryTask as _retryTask,
  resetAndStart as _resetAndStart,
  replanFromTask as _replanFromTask,
  pauseTask as _pauseTask,
  nudgeTask as _nudgeTask,
  buildNudgePrompt as _buildNudgePrompt,
} from './task-control.js';
import {
  reviewAndDispatch as _reviewAndDispatch,
  dispatchNext as _dispatchNext,
  dispatchTask as _dispatchTask,
  executeTaskPipeline as _executeTaskPipeline,
} from './dispatch.js';
import {
  onTaskCompleted as _onTaskCompleted,
  onTaskFailed as _onTaskFailed,
} from './callbacks.js';
import {
  triggerReplan as _triggerReplan,
  approveReplan as _approveReplan,
  getPendingReplanChangesJson as _getPendingReplanChangesJson,
  approveReplanWithModifications as _approveReplanWithModifications,
  rejectReplan as _rejectReplan,
} from './replan-handler.js';
import {
  rollback as _rollback,
  confirmRollback as _confirmRollback,
  cancelRollback as _cancelRollback,
} from './rollback-handler.js';
import {
  startFeedbackInvestigation as _startFeedbackInvestigation,
  buildFeedbackInvestigationPrompt as _buildFeedbackInvestigationPrompt,
  readInvestigationResult as _readInvestigationResult,
} from './feedback-handler.js';
import {
  mergeAndCleanup as _mergeAndCleanup,
} from './merge-handler.js';
import {
  startEventScanner as _startEventScanner,
  sendCheckIn as _sendCheckIn,
  clearCheckInState as _clearCheckInState,
  clearTechLeadNudgeState as _clearTechLeadNudgeState,
} from './event-scanner.js';
import {
  triggerTaskReview as _triggerTaskReview,
  handleTaskReviewResult as _handleTaskReviewResult,
  triggerConflictReview as _triggerConflictReview,
  nudgeConflictReview as _nudgeConflictReview,
  handleConflictResolutionResult as _handleConflictResolutionResult,
  triggerPhaseEvaluation as _triggerPhaseEvaluation,
  handlePhaseResult as _handlePhaseResult,
  triggerFailedTaskReview as _triggerFailedTaskReview,
  handleFailedTaskReviewResult as _handleFailedTaskReviewResult,
} from './review-handler.js';
import type { MergeConflictPayload } from './orchestrator-types.js';

// ============================================================
// GoalOrchestrator — facade + 核心工具方法
// ============================================================

export class GoalOrchestrator {
  deps: OrchestratorDeps;
  mergeLocks = new Map<string, Promise<void>>();
  stateLocks = new Map<string, Promise<void>>();
  activeDrives = new Map<string, GoalDriveState>();

  // Check-in 监工状态（subtask）
  checkInCounts = new Map<string, number>();         // taskId → check-in 次数
  lastCheckInAt = new Map<string, number>();         // taskId → 上次 check-in 时间

  // Tech Lead 轻推状态（completed + unmerged 任务）
  techLeadNudgeCounts = new Map<string, number>();   // taskId → 轻推次数
  lastTechLeadNudgeAt = new Map<string, number>();   // taskId → 上次轻推时间

  // goal event 重试计数（eventId → 失败次数），超过上限后放弃并标记已处理
  goalEventRetryCounts = new Map<string, number>();

  // task event 重试计数（eventId → 失败次数），超过上限后放弃并标记已处理
  taskEventRetryCounts = new Map<string, number>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  // ============================================================
  // 核心工具方法（被多个 handler 共用，保留在类内）
  // ============================================================

  /** 任务标签（task ID 已含 goal seq 前缀，如 g2t1） */
  getTaskLabel(_state: GoalDriveState, taskId: string): string {
    return taskId;
  }

  /** 串行化对同一 goal 的状态操作，防止并发 read-modify-write race condition */
  async withStateLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
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

  /** 同步 Goal 元数据 status */
  async syncGoalMetaStatus(goalId: string, status: string): Promise<void> {
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
  async syncGoalMeta(state: GoalDriveState): Promise<void> {
    try {
      const meta = await this.deps.goalMetaRepo.get(state.goalId);
      if (!meta) return;

      const total = state.tasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
      const completed = state.tasks.filter(t => t.status === 'completed' && (!t.branchName || t.merged)).length;
      const running = state.tasks.filter(t => t.status === 'dispatched' || t.status === 'running').length;
      const failed = state.tasks.filter(t => t.status === 'failed').length;
      meta.progress = JSON.stringify({ completed, total, running, failed });

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
  getStuckReason(state: GoalDriveState): string {
    const reasons: string[] = [];

    const blockedFeedback = state.tasks.filter(t => t.status === 'blocked_feedback');
    if (blockedFeedback.length > 0) reasons.push(`${blockedFeedback.length} 个任务有待处理反馈`);

    const paused = state.tasks.filter(t => t.status === 'paused');
    if (paused.length > 0) reasons.push(`${paused.length} 个任务已暂停`);

    const unmerged = state.tasks.filter(t => t.status === 'completed' && t.branchName && !t.merged);
    if (unmerged.length > 0) reasons.push(`${unmerged.length} 个任务完成但合并失败`);

    const failedTasks = state.tasks.filter(t => t.status === 'failed');
    if (failedTasks.length > 0) reasons.push(`${failedTasks.length} 个任务执行失败`);

    if (reasons.length === 0) reasons.push('存在无法满足的依赖关系');
    return reasons.join('; ');
  }

  /** 获取下一步描述 */
  getNextStepSummary(state: GoalDriveState): string {
    const running = state.tasks.filter(t => t.status === 'dispatched' || t.status === 'running');
    if (running.length > 0) {
      const labels = running.map(t => this.getTaskLabel(state, t.id)).join(', ');
      return `正在执行: ${labels}`;
    }
    return getProgressSummary(state);
  }

  async getState(goalId: string): Promise<GoalDriveState | null> {
    return this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
  }

  async saveState(state: GoalDriveState): Promise<void> {
    state.updatedAt = Date.now();
    await this.deps.goalRepo.save(state);
  }

  /** 发送通知到日志 channel */
  async notify(
    threadId: string,
    message: string,
    type?: NotifyType,
    options?: NotifyOptions,
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

      if (logChannelId) {
        await this.deps.mq.sendEmbed(logChannelId, message, {
          color: embedColor,
          components: options?.components,
        });
      } else {
        logger.info(`[Orchestrator][notify] ${message}`);
      }

      if (options?.driveChannel) {
        await this.deps.mq.sendEmbed(threadId, message, {
          color: embedColor,
        });
      }
    } catch (err: any) {
      logger.error('[Orchestrator] Failed to send notification:', err);
    }
  }

  /** 记录 Timeline 事件 */
  appendTimeline(goalId: string, message: string, type: string = 'info'): void {
    const VALID_TYPES = ['success', 'error', 'warning', 'info', 'pipeline'] as const;
    type ValidType = typeof VALID_TYPES[number];
    const safeType: ValidType = (VALID_TYPES as readonly string[]).includes(type)
      ? type as ValidType
      : 'info';
    try {
      this.deps.goalTimelineRepo.append(goalId, message, safeType);
    } catch (err: any) {
      logger.warn(`[Orchestrator] appendTimeline failed: ${err.message}`);
    }
  }

  /** 通知 + 记录 Timeline */
  async notifyGoal(
    state: GoalDriveState,
    message: string,
    type?: NotifyType,
    options?: NotifyOptions,
  ): Promise<void> {
    await this.notify(state.goalChannelId, message, type, options);
    if (!options?.logOnly) {
      this.appendTimeline(state.goalId, message, type ?? 'info');
    }
  }

  getGuildId(): string | null {
    return getAuthorizedGuildId() ?? null;
  }

  /** 获取 goal channel 所在的 Category ID */
  async findCategoryId(goalChannelId: string): Promise<string | null> {
    // Try Discord API chain first
    try {
      let channel = await this.deps.client.channels.fetch(goalChannelId);
      for (let i = 0; i < 3 && channel; i++) {
        if (channel.type === ChannelType.GuildCategory) return channel.id;
        if ('parentId' in channel && channel.parentId) {
          channel = await this.deps.client.channels.fetch(channel.parentId);
        } else {
          break;
        }
      }
    } catch { /* ignore */ }

    // Fall back to DB traversal (handles archived/unfetchable threads)
    try {
      let channelId: string | null = goalChannelId;
      for (let i = 0; i < 4 && channelId; i++) {
        const row = await this.deps.channelRepo.get(channelId);
        if (!row?.parentChannelId) break;
        channelId = row.parentChannelId;
        try {
          const parent = await this.deps.client.channels.fetch(channelId);
          if (parent?.type === ChannelType.GuildCategory) return channelId;
        } catch { /* continue traversal */ }
      }
    } catch { /* ignore */ }

    return null;
  }

  /** 获取 goal worktree 目录 */
  async getGoalWorktreeDir(state: GoalDriveState): Promise<string | null> {
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

  findWorktreeDir(worktreeListOutput: string, branchName: string): string | null {
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

  async safeListWorktrees(baseCwd: string): Promise<string | null> {
    try {
      return await execGit(
        ['worktree', 'list', '--porcelain'],
        baseCwd,
        'safeListWorktrees',
      );
    } catch {
      return null;
    }
  }

  /** 检测任务的 task.feedback 事件 */
  async checkFeedbackFile(_state: GoalDriveState, task: GoalTask): Promise<GoalTaskFeedback | null> {
    const parsed = this.deps.taskEventRepo.read<{
      type?: string;
      reason?: string;
      details?: string;
    }>(task.id, 'task.feedback');
    if (!parsed || !parsed.type || !parsed.reason) return null;
    return { type: parsed.type, reason: parsed.reason, details: parsed.details };
  }

  async generateBranchName(task: GoalTask, state: GoalDriveState): Promise<string> {
    const prefix = task.type === '调研' ? 'research' : 'feat';
    const translated = await translateToBranchName(task.description);
    const taskLabel = this.getTaskLabel(state, task.id);
    return `${prefix}/${taskLabel}-${translated.slice(0, 30) || 'task'}`;
  }

  buildTaskPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const parts: string[] = [];

    parts.push(ps.render('orchestrator.task', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_TYPE: task.type,
      TASK_DESCRIPTION: task.description,
    }));

    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.task.detail_plan', { DETAIL_PLAN_TEXT: task.detailPlan });
      if (s) parts.push(s);
    }

    const req = ps.tryRender('orchestrator.task.requirements', {});
    if (req) parts.push(req);
    const fb = ps.tryRender('orchestrator.task.feedback_protocol', { TASK_ID: task.id });
    if (fb) parts.push(fb);

    if (task.type === '调研') {
      const s = ps.tryRender('orchestrator.task.research_rules', {});
      if (s) parts.push(s);
    }
    if (task.type === '占位') {
      const s = ps.tryRender('orchestrator.task.placeholder_rules', {});
      if (s) parts.push(s);
    }

    return parts.join('\n\n');
  }

  /** 确保 Tech Lead Channel 有 Opus 会话 */
  ensureGoalChannelSession(state: GoalDriveState, guildId: string): void {
    const techLeadChannelId = state.techLeadChannelId ?? state.goalChannelId;
    this.deps.stateManager.getOrCreateSession(guildId, techLeadChannelId, {
      name: `tech-lead-${state.goalName}`,
      cwd: state.baseCwd,
    });
    this.deps.stateManager.setSessionCwd(guildId, techLeadChannelId, state.baseCwd);
    this.deps.stateManager.setSessionModel(guildId, techLeadChannelId, this.deps.config.pipelineOpusModel);
  }

  /** 为 per-task 审计创建独立的 hidden audit session */
  createAuditSubSession(state: GoalDriveState, task: GoalTask, guildId: string): string {
    const auditSessionKey = `audit-${task.id}`;
    this.deps.stateManager.getOrCreateSession(guildId, auditSessionKey, {
      name: `audit-${task.id}`,
      cwd: state.baseCwd,
      hidden: true,
    });
    this.deps.stateManager.setSessionModel(guildId, auditSessionKey, this.deps.config.pipelineOpusModel);
    this.deps.stateManager.setSessionForkInfo(guildId, auditSessionKey, state.goalChannelId, task.branchName ?? '');
    logger.info(`[AuditSession] Created hidden audit session for task ${task.id}`);
    return auditSessionKey;
  }

  // ========== Usage / Pipeline 辅助 ==========

  emptyUsage(): ChatUsageResult {
    return {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      total_cost_usd: 0, duration_ms: 0,
    };
  }

  accumulateUsage(total: ChatUsageResult, single: ChatUsageResult): void {
    total.input_tokens += single.input_tokens;
    total.output_tokens += single.output_tokens;
    total.cache_read_input_tokens += single.cache_read_input_tokens;
    total.cache_creation_input_tokens += single.cache_creation_input_tokens;
    total.total_cost_usd += single.total_cost_usd;
    total.duration_ms += single.duration_ms;
  }

  switchSessionModel(guildId: string, channelId: string, model: string, _phase?: PipelinePhase): void {
    this.deps.stateManager.clearSessionClaudeId(guildId, channelId);
    this.deps.stateManager.setSessionModel(guildId, channelId, model);
  }

  async updatePipelinePhase(goalId: string, taskId: string, phase: PipelinePhase): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.pipelinePhase = phase;
      await this.saveState(state);
    });
  }

  async isTaskStillRunning(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    return task?.status === 'running';
  }

  async getTaskStatus(goalId: string, taskId: string): Promise<string> {
    const state = await this.getState(goalId);
    if (!state) return 'unknown';
    const task = state.tasks.find(t => t.id === taskId);
    return task?.status ?? 'unknown';
  }

  executeTaskInBackground(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    message: string,
  ): void {
    (async () => {
      const usage = this.emptyUsage();
      try {
        logger.info(`[Orchestrator] Task ${taskId} executing in channel ${channelId}`);
        const u = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, message, 'orchestrator');
        this.accumulateUsage(usage, u);
        logger.info(`[Orchestrator] Task ${taskId} completed`);
        await this.onTaskCompleted(goalId, taskId, usage);
      } catch (err: any) {
        if (err instanceof ClaudeExecutionError && (
          err.errorType === ClaudeErrorType.AUTH_ERROR ||
          err.errorType === ClaudeErrorType.API_ERROR
        )) {
          logger.warn(`[Orchestrator] Task ${taskId} got ${err.errorType} in background, keeping task running for interceptor retry`);
          return;
        }
        logger.error(`[Orchestrator] Task ${taskId} failed:`, err);
        try {
          await this.onTaskFailed(goalId, taskId, err.message, usage);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr);
        }
      }
    })();
  }

  // ============================================================
  // Facade 方法 — 委托到各 handler 文件
  // ============================================================

  // -- Drive lifecycle --
  async startDrive(params: import('./orchestrator-types.js').StartDriveParams) { return _startDrive(this, params); }
  async pauseDrive(goalId: string) { return _pauseDrive(this, goalId); }
  async pauseAllRunningDrives() { return _pauseAllRunningDrives(this); }
  async resumeDrive(goalId: string) { return _resumeDrive(this, goalId); }
  async getStatus(goalId: string) { return _getStatus(this, goalId); }
  async restoreRunningDrives() { return _restoreRunningDrives(this); }

  // -- Task control --
  async skipTask(goalId: string, taskId: string) { return _skipTask(this, goalId, taskId); }
  async markTaskDone(goalId: string, taskId: string) { return _markTaskDone(this, goalId, taskId); }
  async retryTask(goalId: string, taskId: string) { return _retryTask(this, goalId, taskId); }
  async resetAndStart(goalId: string, taskId: string) { return _resetAndStart(this, goalId, taskId); }
  async replanFromTask(goalId: string, taskId: string) { return _replanFromTask(this, goalId, taskId); }
  async pauseTask(goalId: string, taskId: string) { return _pauseTask(this, goalId, taskId); }
  async nudgeTask(goalId: string, taskId: string) { return _nudgeTask(this, goalId, taskId); }
  buildNudgePrompt(task: GoalTask, label: string) { return _buildNudgePrompt(task, label); }

  // -- Dispatch --
  async reviewAndDispatch(state: GoalDriveState, completedTaskId?: string) { return _reviewAndDispatch(this, state, completedTaskId); }
  async dispatchNext(state: GoalDriveState) { return _dispatchNext(this, state); }
  async dispatchTask(state: GoalDriveState, task: GoalTask) { return _dispatchTask(this, state, task); }
  executeTaskPipeline(goalId: string, taskId: string, guildId: string, channelId: string, task: GoalTask, state: GoalDriveState) {
    return _executeTaskPipeline(this, goalId, taskId, guildId, channelId, task, state);
  }

  // -- Callbacks --
  async onTaskCompleted(goalId: string, taskId: string, usage?: ChatUsageResult) { return _onTaskCompleted(this, goalId, taskId, usage); }
  async onTaskFailed(goalId: string, taskId: string, error: string, usage?: ChatUsageResult) { return _onTaskFailed(this, goalId, taskId, error, usage); }

  // -- Replan --
  async triggerReplan(state: GoalDriveState, triggerTaskId: string, feedback: GoalTaskFeedback) { return _triggerReplan(this, state, triggerTaskId, feedback); }
  async approveReplan(goalId: string) { return _approveReplan(this, goalId); }
  async getPendingReplanChangesJson(goalId: string) { return _getPendingReplanChangesJson(this, goalId); }
  async approveReplanWithModifications(goalId: string, modifiedChangesJson: string) { return _approveReplanWithModifications(this, goalId, modifiedChangesJson); }
  async rejectReplan(goalId: string) { return _rejectReplan(this, goalId); }

  // -- Rollback --
  async rollback(goalId: string, checkpointId: string) { return _rollback(this, goalId, checkpointId); }
  async confirmRollback(goalId: string) { return _confirmRollback(this, goalId); }
  async cancelRollback(goalId: string) { return _cancelRollback(this, goalId); }

  // -- Feedback --
  startFeedbackInvestigation(state: GoalDriveState, task: GoalTask, guildId: string) { return _startFeedbackInvestigation(this, state, task, guildId); }
  buildFeedbackInvestigationPrompt(task: GoalTask, state: GoalDriveState) { return _buildFeedbackInvestigationPrompt(this, task, state); }
  async readInvestigationResult(state: GoalDriveState, task: GoalTask) { return _readInvestigationResult(this, state, task); }

  // -- Merge --
  async mergeAndCleanup(state: GoalDriveState, task: GoalTask) { return _mergeAndCleanup(this, state, task); }

  // -- Event scanner --
  startEventScanner() { return _startEventScanner(this); }
  sendCheckIn(state: GoalDriveState, task: GoalTask, guildId: string, attempt: number, reviewIssues?: string) {
    return _sendCheckIn(this, state, task, guildId, attempt, reviewIssues);
  }
  clearCheckInState(taskId: string) { return _clearCheckInState(this, taskId); }
  clearTechLeadNudgeState(taskId: string) { return _clearTechLeadNudgeState(this, taskId); }

  // -- Review / Audit --
  triggerTaskReview(state: GoalDriveState, task: GoalTask, guildId: string) { return _triggerTaskReview(this, state, task, guildId); }
  async handleTaskReviewResult(goalId: string, taskId: string, result: { verdict?: string; summary?: string; issues?: string[] }) {
    return _handleTaskReviewResult(this, goalId, taskId, result);
  }
  triggerConflictReview(state: GoalDriveState, task: GoalTask, guildId: string, payload: MergeConflictPayload) {
    return _triggerConflictReview(this, state, task, guildId, payload);
  }
  nudgeConflictReview(state: GoalDriveState, task: GoalTask, guildId: string, attempt: number) {
    return _nudgeConflictReview(this, state, task, guildId, attempt);
  }
  async handleConflictResolutionResult(goalId: string, taskId: string, result: { resolved: boolean; summary?: string }) {
    return _handleConflictResolutionResult(this, goalId, taskId, result);
  }
  triggerPhaseEvaluation(state: GoalDriveState, phase: number, guildId: string) {
    return _triggerPhaseEvaluation(this, state, phase, guildId);
  }
  async handlePhaseResult(goalId: string, triggerTaskId: string, result: { decision?: string; summary?: string; issues?: string[] }) {
    return _handlePhaseResult(this, goalId, triggerTaskId, result);
  }
  triggerFailedTaskReview(state: GoalDriveState, task: GoalTask, guildId: string) {
    return _triggerFailedTaskReview(this, state, task, guildId);
  }
  async handleFailedTaskReviewResult(goalId: string, taskId: string, payload: { verdict?: string; reason?: string }) {
    return _handleFailedTaskReviewResult(this, goalId, taskId, payload);
  }
}
