/**
 * Event Scanner — 事件扫描与监工逻辑
 *
 * 从 GoalOrchestrator 提取的事件扫描器：
 * 1. 定时扫描 goal 级别事件（goal.drive）
 * 2. 扫描并分发 task 级别事件（task.completed / review / replan / merge.conflict）
 * 3. 检测 orphaned tasks（session 已结束但无事件上报）并触发 check-in
 * 4. 监控 completed + unmerged 任务的 tech lead 状态
 */

import type { GoalDriveState, GoalTask } from '../types/index.js';
import type { GoalOrchestrator } from './index.js';
import { logger } from '../utils/logger.js';
import { StateManager } from '../bot/state.js';
import type { MergeConflictPayload } from './orchestrator-types.js';
import { CHECK_IN_COOLDOWN, MAX_CHECK_INS } from './orchestrator-types.js';

/**
 * 启动事件扫描器（5s 间隔），自动轮询 goal/task 事件和 orphan 检测。
 */
export function startEventScanner(ctx: GoalOrchestrator): void {
  const INTERVAL = 5_000;
  const tick = async () => {
    try {
      await processGoalEvents(ctx);
    } catch (e) {
      logger.error('[Scanner] Error processing goal events:', e);
    }
    try {
      await processPendingEvents(ctx);
    } catch (e) {
      logger.error('[Scanner] Error processing pending events:', e);
    }
    try {
      await checkOrphanedTasks(ctx);
    } catch (e) {
      logger.error('[Scanner] Error checking orphaned tasks:', e);
    }
    setTimeout(tick, INTERVAL);
  };
  setTimeout(tick, INTERVAL);
  logger.info('[Scanner] Event scanner started (5s interval)');
}

/** 扫描并处理 goal 级别事件（goal.drive 等） */
export async function processGoalEvents(ctx: GoalOrchestrator): Promise<void> {
  const MAX_RETRIES = 5;
  const pending = ctx.deps.goalEventRepo.findPending();
  for (const ev of pending) {
    try {
      if (ev.eventType === 'goal.drive') {
        const p = ev.payload as {
          goalName: string;
          goalChannelId: string;
          baseCwd: string;
          maxConcurrent?: number;
        };
        logger.info(`[Scanner] Processing goal.drive for goal ${ev.goalId}`);
        await ctx.startDrive({
          goalId: ev.goalId,
          goalName: p.goalName,
          goalChannelId: p.goalChannelId,
          baseCwd: p.baseCwd,
          maxConcurrent: p.maxConcurrent,
        });
      }
      ctx.goalEventRetryCounts.delete(ev.id);
      ctx.deps.goalEventRepo.markProcessed(ev.id);
    } catch (err: any) {
      const retries = (ctx.goalEventRetryCounts.get(ev.id) ?? 0) + 1;
      ctx.goalEventRetryCounts.set(ev.id, retries);
      if (retries >= MAX_RETRIES) {
        logger.error(`[Scanner] goal.drive for ${ev.goalId} failed ${retries} times, giving up:`, err);
        ctx.deps.goalEventRepo.markProcessed(ev.id);
        ctx.goalEventRetryCounts.delete(ev.id);
        try {
          const p = ev.payload as { goalChannelId?: string };
          if (p.goalChannelId) {
            await ctx.notify(p.goalChannelId, `Drive 启动失败（已重试 ${retries} 次）：${err.message}\n请检查任务列表和目录配置后重新发送 goal.drive 事件。`, 'error');
          }
        } catch (notifyErr: any) {
          logger.warn(`[Scanner] Failed to notify goal channel about drive failure: ${notifyErr.message}`);
        }
      } else {
        logger.warn(`[Scanner] goal.drive for ${ev.goalId} failed (attempt ${retries}/${MAX_RETRIES}): ${err.message} — will retry next tick`);
      }
    }
  }
}

export async function processPendingEvents(ctx: GoalOrchestrator): Promise<void> {
  const pending = ctx.deps.taskEventRepo.findPending();
  if (pending.length === 0) return;

  for (const ev of pending) {
    // 找到对应的 active drive
    if (!ev.goalId) {
      ctx.deps.taskEventRepo.markProcessed(ev.id);
      continue;
    }

    const state = ctx.activeDrives.get(ev.goalId);
    if (!state) {
      // goal 不在内存中（可能已完成）— 标记为已处理
      ctx.deps.taskEventRepo.markProcessed(ev.id);
      continue;
    }

    // 暂停/完成的 goal 不自动处理事件，等 goal 恢复 running 后再处理
    if (state.status !== 'running') continue;

    const task = state.tasks.find(t => t.id === ev.taskId);
    if (!task) {
      ctx.deps.taskEventRepo.markProcessed(ev.id);
      continue;
    }

    try {
      switch (ev.eventType) {
        case 'task.completed':
        case 'task.feedback':
          // 任务完成/反馈事件 — 只处理 running 状态的任务
          if (task.status !== 'running') {
            ctx.deps.taskEventRepo.markProcessed(ev.id);
            continue;
          }
          logger.info(`[Scanner] Processing '${ev.eventType}' for task ${ev.taskId}`);
          await ctx.onTaskCompleted(ev.goalId, ev.taskId);
          break;

        case 'review.task_result': {
          // Per-task 审核结果 — 处理 completed 但未 merged 的任务
          if (task.status !== 'completed' || task.merged) {
            ctx.deps.taskEventRepo.markProcessed(ev.id);
            continue;
          }
          logger.info(`[Scanner] Processing review.task_result for task ${ev.taskId}`);
          const rp = (ev.payload ?? {}) as Record<string, unknown>;
          await ctx.handleTaskReviewResult(ev.goalId, ev.taskId, {
            verdict: typeof rp.verdict === 'string' ? rp.verdict : undefined,
            summary: typeof rp.summary === 'string' ? rp.summary : undefined,
            issues: Array.isArray(rp.issues) ? rp.issues as string[] : undefined,
          });
          break;
        }

        case 'review.phase_result': {
          // Phase 评估结果
          logger.info(`[Scanner] Processing review.phase_result for task ${ev.taskId}`);
          const pp = (ev.payload ?? {}) as Record<string, unknown>;
          await ctx.handlePhaseResult(ev.goalId, ev.taskId, {
            decision: typeof pp.decision === 'string' ? pp.decision : undefined,
            summary: typeof pp.summary === 'string' ? pp.summary : undefined,
            issues: Array.isArray(pp.issues) ? pp.issues as string[] : undefined,
          });
          break;
        }

        case 'merge.conflict': {
          // Merge 冲突等待 tech lead 处理 — tech lead 忙时跳过，下轮再试
          if (task.merged) {
            ctx.deps.taskEventRepo.markProcessed(ev.id);
            continue;
          }
          const guildId = ctx.getGuildId();
          if (!guildId) continue; // 未连接 guild，下轮重试
          const techLeadChannelId = state.techLeadChannelId ?? state.goalChannelId;
          const techLeadLockKey = StateManager.channelLockKey(guildId, techLeadChannelId);
          if (ctx.deps.claudeClient.isRunning(techLeadLockKey)) {
            continue; // tech lead 忙，不标 processed，下轮重试
          }
          logger.info(`[Scanner] Processing merge.conflict for task ${ev.taskId}`);
          ctx.triggerConflictReview(state, task, guildId, ev.payload as MergeConflictPayload);
          break;
        }

        case 'review.conflict_result': {
          // Reviewer 已解决冲突，继续 merge 流程
          if (task.merged) {
            ctx.deps.taskEventRepo.markProcessed(ev.id);
            continue;
          }
          logger.info(`[Scanner] Processing review.conflict_result for task ${ev.taskId}`);
          const cp = (ev.payload ?? {}) as Record<string, unknown>;
          await ctx.handleConflictResolutionResult(ev.goalId, ev.taskId, {
            resolved: cp.resolved === true,
            summary: typeof cp.summary === 'string' ? cp.summary : undefined,
          });
          break;
        }

        case 'review.failed_task': {
          // Tech lead 对失败任务的裁决 — 只处理 failed 状态的任务
          if (task.status !== 'failed') {
            ctx.deps.taskEventRepo.markProcessed(ev.id);
            continue;
          }
          logger.info(`[Scanner] Processing review.failed_task for task ${ev.taskId}`);
          const fp = (ev.payload ?? {}) as Record<string, unknown>;
          await ctx.handleFailedTaskReviewResult(ev.goalId, ev.taskId, {
            verdict: typeof fp.verdict === 'string' ? fp.verdict : undefined,
            reason: typeof fp.reason === 'string' ? fp.reason : undefined,
          });
          break;
        }

        default:
          logger.warn(`[Scanner] Unknown event type: ${ev.eventType}`);
      }
      ctx.deps.taskEventRepo.markProcessed(ev.id);
    } catch (err: any) {
      const MAX_RETRIES = 5;
      const retries = (ctx.taskEventRetryCounts.get(ev.id) ?? 0) + 1;
      ctx.taskEventRetryCounts.set(ev.id, retries);
      if (retries >= MAX_RETRIES) {
        logger.error(`[Scanner] Event ${ev.id} (${ev.eventType}) failed ${retries} times, giving up:`, err);
        ctx.deps.taskEventRepo.markProcessed(ev.id);
        ctx.taskEventRetryCounts.delete(ev.id);
      } else {
        logger.warn(`[Scanner] Failed to process event ${ev.id} (attempt ${retries}/${MAX_RETRIES}): ${err.message}`);
      }
    }
  }
}

/**
 * 扫描所有 running 任务，检测 session 已结束但无事件上报的情况。
 * 触发 check-in prompt 催促 AI 汇报状态，超限则标记失败。
 */
export async function checkOrphanedTasks(ctx: GoalOrchestrator): Promise<void> {
  const now = Date.now();
  const guildId = ctx.getGuildId();
  if (!guildId) return;

  for (const state of ctx.activeDrives.values()) {
    if (state.status !== 'running') continue;

    for (const task of state.tasks) {
      if (task.status !== 'running' || !task.channelId) continue;

      // 检查是否有未处理的事件（scanner 会处理这些，不需要 check-in）
      const hasCompletedEvent = ctx.deps.taskEventRepo.read(task.id, 'task.completed') !== null;
      const hasFeedbackEvent = ctx.deps.taskEventRepo.read(task.id, 'task.feedback') !== null;
      if (hasCompletedEvent || hasFeedbackEvent) continue;

      // 检查 Claude 进程是否还在运行（比 session 状态更可靠，防止状态滞后导致误触发）
      const lockKey = StateManager.channelLockKey(guildId, task.channelId);
      if (ctx.deps.claudeClient.isRunning(lockKey)) continue;

      // 检查 session 状态
      const sessionStatus = ctx.deps.stateManager.getChannelSessionStatus(task.channelId);
      // 只在 session idle 或 closed 时触发 check-in（active/waiting 说明 AI 还在工作）
      if (sessionStatus === 'active' || sessionStatus === 'waiting') continue;
      // 如果 sessionStatus 为 null（无 session 记录），也需要 check-in
      if (sessionStatus !== null && sessionStatus !== 'idle' && sessionStatus !== 'closed') continue;

      // Cooldown 检查
      const lastCheckIn = ctx.lastCheckInAt.get(task.id) ?? (task.dispatchedAt || 0);
      if (now - lastCheckIn < CHECK_IN_COOLDOWN) continue;

      const count = ctx.checkInCounts.get(task.id) ?? 0;
      if (count >= MAX_CHECK_INS) {
        // 超限 → 标记失败
        logger.warn(`[CheckIn] Task ${task.id} exceeded max check-ins (${MAX_CHECK_INS}), marking failed`);
        await ctx.onTaskFailed(state.goalId, task.id, `No response after ${MAX_CHECK_INS} check-in attempts`);
        clearCheckInState(ctx, task.id);
        continue;
      }

      // 发送 check-in（若有 review 遗留的 issues，继续携带上下文）
      // 注意：tracking 更新已移入 sendCheckIn，此处无需手动 set
      sendCheckIn(ctx, state, task, guildId, count + 1, task.metadata?.lastReviewIssues as string | undefined);
    }

    // ── Reviewer 监工：completed + unmerged 任务 ──
    // 纯状态检测，不依赖事件（bot 重启后事件可能丢失）
    // 每个任务使用独立 hidden audit session，互不阻塞

    for (const task of state.tasks) {
      if (task.status !== 'completed' || task.merged) continue;

      // 该 task 已有 audit session 且正在运行 → 跳过（不影响其他任务）
      if (task.auditSessionKey) {
        const auditLockKey = StateManager.channelLockKey(guildId, task.auditSessionKey);
        if (ctx.deps.claudeClient.isRunning(auditLockKey)) continue;

        // session 不在运行，但事件已写入 → 等 event scanner 处理
        const pendingResult = ctx.deps.taskEventRepo.read(task.id, 'review.task_result');
        if (pendingResult) continue;
      }

      // Cooldown 检查（基于完成时间或上次轻推时间）
      const lastNudge = ctx.lastTechLeadNudgeAt.get(task.id) ?? (task.completedAt ?? Date.now());
      if (now - lastNudge < CHECK_IN_COOLDOWN) continue;

      const count = ctx.techLeadNudgeCounts.get(task.id) ?? 0;
      if (count >= MAX_CHECK_INS) {
        logger.warn(`[ReviewerNudge] Task ${task.id} exceeded max nudges, marking blocked`);
        task.status = 'blocked';
        task.error = `Reviewer did not respond after ${MAX_CHECK_INS} nudge attempts`;
        await ctx.saveState(state);
        await ctx.notifyGoal(state,
          `Task ${ctx.getTaskLabel(state, task.id)} tech lead stalled (${MAX_CHECK_INS} nudges). Manual intervention needed.`,
          'error',
        );
        clearTechLeadNudgeState(ctx, task.id);
        continue;
      }

      logger.info(`[ReviewerNudge] Nudging tech lead for task ${task.id} (attempt ${count + 1}, phase=${task.pipelinePhase})`);
      if (task.pipelinePhase === 'conflict') {
        ctx.nudgeConflictReview(state, task, guildId, count + 1);  // conflict 仍用 tech lead channel
      } else {
        ctx.triggerTaskReview(state, task, guildId);  // 创建独立 audit session
      }
      ctx.techLeadNudgeCounts.set(task.id, count + 1);
      ctx.lastTechLeadNudgeAt.set(task.id, now);
    }
  }
}

/**
 * 向任务 channel 发送 check-in 催促消息。
 * 异步执行，不阻塞扫描器。
 */
export function sendCheckIn(
  ctx: GoalOrchestrator,
  state: GoalDriveState,
  task: GoalTask,
  guildId: string,
  attempt: number,
  reviewIssues?: string,
): void {
  const taskId = task.id;
  const channelId = task.channelId!;

  // 立即更新 tracking，防止 scanner 在 check-in 期间重复触发
  // （review-handler 等非 scanner 路径调用时同样需要维护冷却状态）
  ctx.checkInCounts.set(taskId, attempt);
  ctx.lastCheckInAt.set(taskId, Date.now());

  (async () => {
    try {
      const ps = ctx.deps.promptService;
      const prompt = ps.render('orchestrator.check_in', {
        TASK_LABEL: ctx.getTaskLabel(state, taskId),
        REVIEW_ISSUES: reviewIssues
          ? `\n## Review Issues\nThe following issues were found in a previous review:\n${reviewIssues}`
          : '',
      });

      await ctx.notifyGoal(state,
        `[GoalOrchestrator] Check-in #${attempt} for ${taskId} (session idle, no event received)`,
        'warning',
      );

      logger.info(`[CheckIn] Sending check-in #${attempt} for task ${taskId}`);
      await ctx.deps.messageHandler.handleBackgroundChat(guildId, channelId, prompt, 'check-in');
    } catch (err: any) {
      logger.error(`[CheckIn] Failed to send check-in for task ${taskId}:`, err);
    }
  })();
}

/** 清除任务的 check-in 追踪状态（subtask + tech lead nudge） */
export function clearCheckInState(ctx: GoalOrchestrator, taskId: string): void {
  ctx.checkInCounts.delete(taskId);
  ctx.lastCheckInAt.delete(taskId);
  clearTechLeadNudgeState(ctx, taskId);
}

/** 清除任务的 tech lead 轻推追踪状态 */
export function clearTechLeadNudgeState(ctx: GoalOrchestrator, taskId: string): void {
  ctx.techLeadNudgeCounts.delete(taskId);
  ctx.lastTechLeadNudgeAt.delete(taskId);
}
