/**
 * Review / Audit 处理器
 *
 * 从 GoalOrchestrator 提取的审核逻辑：
 * - Task review (triggerTaskReview / handleTaskReviewResult)
 * - Conflict review (triggerConflictReview / nudgeConflictReview / handleConflictResolutionResult)
 * - Phase evaluation (triggerPhaseEvaluation / handlePhaseResult)
 */

import type { GoalDriveState, GoalTask } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import type { MergeConflictPayload } from './orchestrator-types.js';
import { MAX_REVIEW_RETRIES } from './orchestrator-types.js';
import { logger } from '../utils/logger.js';
import { execGit } from './git-ops.js';
import { cleanupSubtask } from './goal-branch.js';
import { getPhaseNumber, isPhaseFullyMerged, getProgressSummary } from './task-scheduler.js';
import { cleanupTaskChannel } from './merge-handler.js';

export function triggerTaskReview(ctx: GoalOrchestrator, state: GoalDriveState, task: GoalTask, guildId: string): void {
  const taskId = task.id;
  const goalChannelId = state.goalChannelId;

  // 确保 audit session 存在（幂等，已存在则复用）
  if (!task.auditSessionKey) {
    task.auditSessionKey = ctx.createAuditSubSession(state, task, guildId);
    // 异步持久化，crash 前未写入也安全（重启后 restoreRunningDrives 重建）
    ctx.saveState(state).catch(e => logger.warn(`[AuditSession] saveState failed: ${e.message}`));
  }

  const auditSessionKey = task.auditSessionKey;

  (async () => {
    // 1. 收集 diff stats（失败不影响审核）
    let diffStats = '(unavailable)';
    try {
      const goalDir = await ctx.getGoalWorktreeDir(state);
      if (goalDir && task.branchName) {
        diffStats = await execGit(
          ['diff', '--stat', `${state.goalBranch}...${task.branchName}`],
          goalDir,
          `triggerTaskReview: diff stat for ${taskId}`,
        );
      }
    } catch { /* ignore */ }

    // 2. 渲染 prompt（测试型任务使用专用 prompt，只验证测试思路）
    const ps = ctx.deps.promptService;
    const promptKey = task.type === '测试'
      ? 'orchestrator.test_task_review'
      : 'orchestrator.task_review';
    const prompt = ps.render(promptKey, {
      TASK_LABEL: ctx.getTaskLabel(state, taskId),
      TASK_DESCRIPTION: task.description,
      BRANCH_NAME: task.branchName ?? '(unknown)',
      DIFF_STATS: diffStats,
      TASK_ID: taskId,
    });

    await ctx.notify(goalChannelId,
      `[GoalOrchestrator] Reviewing task ${taskId}: ${task.description}`,
      'pipeline',
    );

    // 3. 纯事件驱动：fire-and-forget，结果由 event scanner 处理
    logger.info(`[PhaseReview] Firing review for ${taskId} via hidden audit session ${auditSessionKey}`);
    ctx.deps.messageHandler.handleBackgroundChat(guildId, auditSessionKey, prompt, 'review')
      .catch(err => logger.error(`[AuditSession] handleBackgroundChat error for ${taskId}:`, err));

    // audit session 不在此处清理，生命周期延伸到 mergeAndCleanup
  })();
}

export function normalizeIssueItem(item: unknown): string {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    // 尝试提取常见的可读文本字段
    const readable = obj.description ?? obj.message ?? obj.text ?? obj.issue ?? obj.title ?? obj.content;
    if (typeof readable === 'string' && readable.trim()) {
      // 有 file/line 时附加位置信息
      const loc = [obj.file, obj.line].filter(Boolean).join(':');
      return loc ? `${loc}: ${readable.trim()}` : readable.trim();
    }
    return JSON.stringify(obj);
  }
  return String(item);
}

/**
 * 将 review.task_result payload 的 issues 字段规范化为字符串数组。
 * 容忍：undefined/null、字符串（未包数组）、对象数组、混合数组。
 */
export function normalizeIssues(issues: unknown): string[] {
  if (!issues) return [];
  const arr = Array.isArray(issues) ? issues : [issues];
  return arr.map(normalizeIssueItem).filter(Boolean);
}

export async function handleTaskReviewResult(
  ctx: GoalOrchestrator,
  goalId: string,
  taskId: string,
  result: { verdict?: string; summary?: string; issues?: string[] },
): Promise<void> {
  await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'completed') return;
    // 已经 merged 的不重复处理
    if (task.merged) return;

    if (result.verdict === 'pass') {
      logger.info(`[PhaseReview] Task ${taskId} passed review: ${result.summary}`);
      await ctx.notifyGoal(state,
        `Review passed: ${ctx.getTaskLabel(state, taskId)} - ${result.summary || 'OK'}`,
        'success',
      );

      if (task.branchName) await ctx.mergeAndCleanup(state, task);

      // 检查 phase 是否全部 merged
      const phase = getPhaseNumber(task);
      if (isPhaseFullyMerged(state, phase)) {
        const guildId = ctx.getGuildId();
        if (guildId) {
          triggerPhaseEvaluation(ctx, state, phase, guildId);
          return; // phase evaluation 会处理 dispatch
        }
      }

      // 非 phase 边界 → 继续调度
      const refreshed = await ctx.getState(goalId);
      if (refreshed && refreshed.status === 'running') await ctx.reviewAndDispatch(refreshed, taskId);
    } else if (result.verdict === 'replan' && task.type === '测试') {
      // 测试设计正确，但发现了实现 bug → 合并测试分支，触发修复 replan
      const issueTexts = normalizeIssues(result.issues);
      const bugDetails = issueTexts.join('\n- ') || result.summary || 'Tests reveal implementation bug';
      logger.info(`[PhaseReview] Test task ${taskId} found bug, notifying tech lead: ${bugDetails}`);
      await ctx.notifyGoal(state,
        `🐛 Test task ${ctx.getTaskLabel(state, taskId)} found bug — merging tests, notifying tech lead\n${bugDetails}`,
        'warning',
      );

      // 先 merge 测试分支（测试是正确的）
      if (task.branchName) await ctx.mergeAndCleanup(state, task);

      // 通知 tech lead 创建修复任务
      const guildIdForBug = ctx.getGuildId();
      if (state.techLeadChannelId && guildIdForBug) {
        triggerTechLeadConsultation(ctx, state, guildIdForBug,
          `测试任务 ${ctx.getTaskLabel(state, taskId)} 发现 bug，请创建修复任务`,
          bugDetails,
        );
      }

      const refreshed = await ctx.getState(goalId);
      if (refreshed && refreshed.status === 'running') {
        await ctx.reviewAndDispatch(refreshed, taskId);
      }
    } else {
      // fail → 打回 subtask 修复
      // normalizeIssues 容忍 AI 返回的各种非标准格式（对象、字符串、混合数组等）
      const issueTexts = normalizeIssues(result.issues);
      const issues = issueTexts.join('\n- ') || result.summary || 'Review failed';
      logger.info(`[PhaseReview] Task ${taskId} failed review: ${issues}`);
      await ctx.notifyGoal(state,
        `Review failed: ${ctx.getTaskLabel(state, taskId)}\nIssues: ${issues}`,
        'warning',
      );

      const refixCount = (task.auditRetries ?? 0) + 1;
      if (refixCount > MAX_REVIEW_RETRIES) {
        // 超限 → 标记失败，关闭 audit session
        task.status = 'failed';
        task.error = `Review failed after ${refixCount} attempts: ${issues}`;
        const guildIdForAudit = ctx.getGuildId();
        if (guildIdForAudit && task.auditSessionKey) {
          ctx.deps.stateManager.archiveSession(guildIdForAudit, task.auditSessionKey, undefined, 'review-failed');
          task.auditSessionKey = undefined;
        }
        await ctx.saveState(state);
        await ctx.notifyGoal(state,
          `Task ${ctx.getTaskLabel(state, taskId)} failed review ${refixCount} times, marking as failed`,
          'error',
        );
        return;
      }

      // 恢复为 running，发送 check-in 带 issues 信息让 subtask 修复
      // 同时将 issues 存入 metadata，供后续周期性 check-in 继续传递上下文
      const reviewIssuesText = `- ${issues}`;
      task.status = 'running';
      task.auditRetries = refixCount;
      task.metadata = { ...task.metadata, lastReviewIssues: reviewIssuesText };
      await ctx.saveState(state);

      const guildId = ctx.getGuildId();
      if (guildId && task.channelId) {
        ctx.sendCheckIn(state, task, guildId, 1, reviewIssuesText);
      }
    }
  });
}

export function triggerConflictReview(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  task: GoalTask,
  guildId: string,
  payload: MergeConflictPayload,
): void {
  (async () => {
    try {
      ctx.ensureGoalChannelSession(state, guildId);
      const techLeadChannelId = state.techLeadChannelId ?? state.goalChannelId;
      const ps = ctx.deps.promptService;
      const prompt = ps.render('orchestrator.conflict_review', {
        TASK_LABEL: ctx.getTaskLabel(state, task.id),
        BRANCH_NAME: payload.branchName,
        GOAL_BRANCH: state.goalBranch,
        TASK_DESCRIPTION: payload.taskDescription,
        GOAL_WORKTREE_DIR: payload.goalWorktreeDir,
        TASK_ID: task.id,
      });
      await ctx.notifyGoal(state,
        `[GoalOrchestrator] Conflict review queued: ${ctx.getTaskLabel(state, task.id)}`,
        'pipeline',
      );
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, techLeadChannelId, prompt, 'review');
    } catch (err: any) {
      logger.error(`[ConflictReview] Failed to trigger conflict review for ${task.id}:`, err);
    }
  })();
}

/**
 * Reviewer 轻推：conflict 阶段 — 运行时重建 payload，不依赖已处理的 merge.conflict 事件。
 * 用于 bot 重启后事件丢失时恢复 conflict review 流程。
 */
export function nudgeConflictReview(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  task: GoalTask,
  guildId: string,
  attempt: number,
): void {
  const branchName = task.branchName;
  if (!branchName) {
    logger.warn(`[ReviewerNudge] Task ${task.id} has no branchName, skipping conflict nudge`);
    return;
  }
  (async () => {
    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `nudgeConflictReview(${task.id}): list worktrees`,
      );
      const goalWorktreeDir = ctx.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        logger.warn(`[ReviewerNudge] Cannot find goal worktree for ${task.id}, skipping nudge`);
        return;
      }
      const subtaskDir = ctx.findWorktreeDir(stdout, branchName);

      await ctx.notifyGoal(state,
        `[GoalOrchestrator] Conflict review nudge #${attempt} for ${ctx.getTaskLabel(state, task.id)} (tech lead stalled)`,
        'warning',
      );
      triggerConflictReview(ctx, state, task, guildId, {
        branchName,
        goalWorktreeDir,
        subtaskDir: subtaskDir ?? null,
        taskDescription: task.description,
      });
    } catch (err: any) {
      logger.error(`[ReviewerNudge] nudgeConflictReview failed for ${task.id}:`, err);
    }
  })();
}

export async function handleConflictResolutionResult(
  ctx: GoalOrchestrator,
  goalId: string,
  taskId: string,
  result: { resolved: boolean; summary?: string },
): Promise<void> {
  await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.merged) return;

    if (result.resolved) {
      task.merged = true;
      ctx.clearTechLeadNudgeState(taskId);
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Reviewer resolved conflict and merged: ${ctx.getTaskLabel(state, taskId)} — ${result.summary ?? 'OK'}`,
        'success',
      );

      // 清理 subtask worktree 和分支
      // merge.conflict 事件在前一 scanner tick 已被 markProcessed，需用 readAny 读取历史 payload
      const conflictPayload = ctx.deps.taskEventRepo.readAny<MergeConflictPayload>(taskId, 'merge.conflict');
      if (task.branchName && conflictPayload?.subtaskDir) {
        await cleanupSubtask(state.baseCwd, conflictPayload.subtaskDir, task.branchName).catch(() => {});
      }

      // 清理 subtask Discord channel
      const guildId = ctx.getGuildId();
      if (guildId) {
        await cleanupTaskChannel(ctx, task, guildId);
      }

      // 关闭 audit session（hidden session，无 Discord channel）
      if (guildId && task.auditSessionKey) {
        ctx.deps.stateManager.archiveSession(guildId, task.auditSessionKey, undefined, 'merged');
        task.auditSessionKey = undefined;
      }

      // 检查 phase 是否全部 merged → 触发 phase 评估或继续调度
      const phase = getPhaseNumber(task);
      if (guildId && isPhaseFullyMerged(state, phase)) {
        triggerPhaseEvaluation(ctx, state, phase, guildId);
        return;
      }
      const refreshed = await ctx.getState(goalId);
      if (refreshed && refreshed.status === 'running') await ctx.reviewAndDispatch(refreshed, taskId);
    } else {
      task.status = 'blocked';
      task.error = `merge conflict (tech lead could not resolve: ${result.summary ?? 'unknown'})`;
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Reviewer could not resolve conflict for ${ctx.getTaskLabel(state, taskId)}: ${result.summary ?? 'unknown'}\nManual resolution needed.`,
        'error',
      );
    }
  });
}

/**
 * 触发 Phase 全局评估。
 * 异步执行，不阻塞调用方。
 */
export function triggerPhaseEvaluation(ctx: GoalOrchestrator, state: GoalDriveState, phase: number, guildId: string): void {
  const goalId = state.goalId;
  const techLeadChannelId = state.techLeadChannelId ?? state.goalChannelId;

  (async () => {
    try {
      ctx.ensureGoalChannelSession(state, guildId);

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

      const ps = ctx.deps.promptService;
      const prompt = ps.render('orchestrator.phase_review', {
        PHASE_NUMBER: String(phase),
        GOAL_NAME: state.goalName,
        TASK_REVIEW_SUMMARIES: summaries,
        PROGRESS_SUMMARY: progress,
        PHASE_TASK_ID: phaseTaskId,
      });

      await ctx.notifyGoal(state,
        `[GoalOrchestrator] Phase ${phase} complete — triggering evaluation`,
        'pipeline',
      );

      logger.info(`[PhaseReview] Triggering phase ${phase} evaluation for goal ${goalId}`);
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, techLeadChannelId, prompt, 'review');

      // Fallback: 检查事件
      const phaseResult = ctx.deps.taskEventRepo.read<{
        decision?: string;
        summary?: string;
        issues?: string[];
      }>(phaseTaskId, 'review.phase_result');
      if (phaseResult) {
        // 标记已处理，防止 scanner 重复处理
        ctx.deps.taskEventRepo.markProcessedByTask(phaseTaskId, 'review.phase_result');
        await handlePhaseResult(ctx, goalId, phaseTaskId, phaseResult);
      } else {
        // 没写事件 → 默认 continue
        logger.warn(`[PhaseReview] No review.phase_result event for phase ${phase}, defaulting to continue`);
        await handlePhaseResult(ctx, goalId, phaseTaskId, { decision: 'continue', summary: 'Auto-continue (no event)' });
      }
    } catch (err: any) {
      // 评估失败 → 默认 continue
      logger.error(`[PhaseReview] Phase ${phase} evaluation failed:`, err);
      await handlePhaseResult(ctx, goalId, 'fallback', { decision: 'continue', summary: `Evaluation failed: ${err.message}` });
    }
  })();
}

/**
 * 任务失败后通知 tech lead，由 tech lead 决定是否 retry。
 */
export function triggerFailedTaskReview(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  task: GoalTask,
  guildId: string,
): void {
  (async () => {
    try {
      ctx.ensureGoalChannelSession(state, guildId);
      const techLeadChannelId = state.techLeadChannelId ?? state.goalChannelId;
      const ps = ctx.deps.promptService;
      const prompt = ps.render('orchestrator.failed_task_review', {
        TASK_LABEL: ctx.getTaskLabel(state, task.id),
        TASK_DESCRIPTION: task.description,
        ERROR: task.error ?? '(unknown)',
        TASK_ID: task.id,
      });
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, techLeadChannelId, prompt, 'review');
    } catch (err: any) {
      logger.error(`[FailedTaskReview] Failed to trigger review for ${task.id}:`, err);
    }
  })();
}

/**
 * 处理 tech lead 对失败任务的裁决。
 * verdict=retry → 调用 retryTask；verdict=skip → 通知用户需要人工干预。
 */
export async function handleFailedTaskReviewResult(
  ctx: GoalOrchestrator,
  goalId: string,
  taskId: string,
  payload: { verdict?: string; reason?: string },
): Promise<void> {
  const { verdict, reason } = payload;

  if (verdict === 'retry') {
    logger.info(`[FailedTaskReview] Tech lead decided to retry task ${taskId}: ${reason}`);
    const ok = await ctx.retryTask(goalId, taskId);
    if (!ok) {
      logger.warn(`[FailedTaskReview] retryTask returned false for ${taskId}`);
    }
  } else if (verdict === 'replan') {
    // Tech lead 已通过 MCP 工具直接修改任务图，这里只需 skip 失败任务并继续调度
    logger.info(`[FailedTaskReview] Tech lead decided to skip failed task ${taskId} and adjust tasks: ${reason}`);
    await ctx.withStateLock(goalId, async () => {
      const state = await ctx.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'skipped';
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Tech lead skipped failed task ${ctx.getTaskLabel(state, taskId)} and adjusted plan.\n${reason ? `Reason: ${reason}` : ''}`,
        'info',
      );
    });
    const refreshed = await ctx.getState(goalId);
    if (refreshed && refreshed.status === 'running') {
      await ctx.reviewAndDispatch(refreshed, taskId);
    }
  } else if (verdict === 'escalate_user') {
    // tech lead 确认需要人工干预
    await ctx.withStateLock(goalId, async () => {
      const state = await ctx.getState(goalId);
      if (!state) return;
      logger.info(`[FailedTaskReview] Tech lead escalates task ${taskId} to user: ${reason}`);
      await ctx.notifyGoal(state,
        `⚠️ Tech lead escalates **${ctx.getTaskLabel(state, taskId)}** to user.\n${reason ? `Reason: ${reason}\n` : ''}Manual intervention required.`,
        'error',
      );
    });
  } else {
    // skip — 标记完成，继续推进 goal
    await ctx.withStateLock(goalId, async () => {
      const state = await ctx.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      logger.info(`[FailedTaskReview] Tech lead decided to skip task ${taskId}: ${reason}`);
      task.status = 'completed';
      task.completedAt = Date.now();
      await ctx.saveState(state);
      await ctx.notifyGoal(state,
        `Tech lead skipped **${ctx.getTaskLabel(state, taskId)}**.${reason ? ` Reason: ${reason}` : ''}`,
        'warning',
      );
      await ctx.reviewAndDispatch(state, taskId);
    });
  }
}

/**
 * 当任务卡住或无法继续时，请求 tech lead 介入调解。
 * 如果没有 tech lead，静默返回（调用方负责 fallback 通知）。
 */
export function triggerTechLeadConsultation(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  guildId: string,
  situation: string,
  details?: string,
): void {
  if (!state.techLeadChannelId) return;

  (async () => {
    try {
      ctx.ensureGoalChannelSession(state, guildId);
      const techLeadChannelId = state.techLeadChannelId!;

      const stuckTasks = state.tasks
        .filter(t => ['failed', 'blocked_feedback', 'blocked'].includes(t.status))
        .map(t =>
          `- **${t.id}**: ${t.description} [${t.status}]` +
          (t.error ? `\n  Error: ${t.error}` : '') +
          (t.feedback ? `\n  Feedback: ${t.feedback.type} — ${t.feedback.reason}` : ''),
        )
        .join('\n') || '(none)';

      const ps = ctx.deps.promptService;
      const prompt = ps.render('orchestrator.tech_lead_consultation', {
        GOAL_NAME: state.goalName,
        GOAL_BRANCH: state.goalBranch,
        GOAL_ID: state.goalId,
        SITUATION: situation,
        CONTEXT: details ?? '',
        STUCK_TASKS: stuckTasks,
      });

      await ctx.deps.messageHandler.handleBackgroundChat(guildId, techLeadChannelId, prompt, 'review');
    } catch (err: any) {
      logger.error(`[TechLeadConsultation] Failed to trigger consultation:`, err);
    }
  })();
}

export async function handlePhaseResult(
  ctx: GoalOrchestrator,
  goalId: string,
  _triggerTaskId: string,
  result: { decision?: string; summary?: string; issues?: string[] },
): Promise<void> {
  await ctx.withStateLock(goalId, async () => {
    const state = await ctx.getState(goalId);
    if (!state || state.status !== 'running') return;

    if (result.decision === 'replan') {
      logger.info(`[PhaseReview] Phase evaluation recommends task adjustment: ${result.summary}`);
      await ctx.notifyGoal(state,
        `**Phase evaluation → needs adjustment:** ${result.summary}`,
        'warning',
      );

      // 通知 tech lead 修改任务
      const guildId = ctx.getGuildId();
      if (state.techLeadChannelId && guildId) {
        triggerTechLeadConsultation(ctx, state, guildId,
          `Phase 评估建议修改任务计划`,
          `${result.summary || 'Phase evaluation recommended task adjustment'}${result.issues ? '\nIssues: ' + result.issues.join('; ') : ''}`,
        );
      }

      const refreshed = await ctx.getState(goalId);
      if (refreshed && refreshed.status === 'running') await ctx.reviewAndDispatch(refreshed);
    } else {
      // continue
      logger.info(`[PhaseReview] Phase evaluation: continue — ${result.summary}`);
      await ctx.notifyGoal(state,
        `**Phase evaluation → continue:** ${result.summary || 'OK'}`,
        'success',
      );
      await ctx.reviewAndDispatch(state);
    }
  });
}
