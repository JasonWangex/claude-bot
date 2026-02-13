/**
 * 子任务调度决策逻辑
 *
 * 决定哪些任务可以被派发（依赖已满足、phase 前置完成）
 */

import type { GoalDriveState, GoalTask } from '../types/index.js';

/**
 * 获取所有依赖已满足的 pending 任务
 *
 * 规则：
 * 1. 状态为 pending
 * 2. 所有 depends 中的任务都已 completed
 * 3. 如果有 phase，前一个 phase 的所有任务都已 completed
 * 4. type 为 '手动' 的任务不自动派发，标记为 blocked
 */
/** 判断任务状态是否视为「已终结」（不再阻塞后续） */
const isTerminal = (status: GoalTask['status']): boolean =>
  status === 'completed' || status === 'skipped' || status === 'cancelled';

export function getDispatchableTasks(state: GoalDriveState): GoalTask[] {
  const taskMap = new Map(state.tasks.map(t => [t.id, t]));
  const dispatchable: GoalTask[] = [];

  // 检查 phase 约束：某个 phase 是否全部完成
  const phaseComplete = (phase: number): boolean => {
    return state.tasks
      .filter(t => t.phase === phase)
      .every(t => isTerminal(t.status));
  };

  for (const task of state.tasks) {
    if (task.status !== 'pending') continue;

    // 占位任务不自动派发
    if (task.type === '占位') continue;

    // 检查显式依赖
    const depsOk = task.depends.every(depId => {
      const dep = taskMap.get(depId);
      return dep && isTerminal(dep.status);
    });
    if (!depsOk) continue;

    // 检查 phase 依赖
    if (task.phase != null && task.phase > 1) {
      if (!phaseComplete(task.phase - 1)) continue;
    }

    dispatchable.push(task);
  }

  return dispatchable;
}

/**
 * 从可派发任务中选出下一批（受并发限制）
 *
 * 已经在 dispatched/running 状态的任务占用并发槽位
 */
export function getNextBatch(state: GoalDriveState): GoalTask[] {
  const activeCount = state.tasks.filter(
    t => t.status === 'dispatched' || t.status === 'running'
  ).length;

  const available = state.maxConcurrent - activeCount;
  if (available <= 0) return [];

  const dispatchable = getDispatchableTasks(state);

  // 手动任务标记为 blocked 而不是派发
  const auto: GoalTask[] = [];
  for (const task of dispatchable) {
    if (task.type === '手动') {
      task.status = 'blocked';
    } else {
      auto.push(task);
    }
  }

  return auto.slice(0, available);
}

/** 检查 Goal 是否全部完成（cancelled/skipped 视为完成） */
export function isGoalComplete(state: GoalDriveState): boolean {
  return state.tasks.every(
    t => t.status === 'completed' || t.status === 'skipped' || t.status === 'cancelled'
  );
}

/** 检查 Goal 是否卡住（没有可派发任务但还有未完成的） */
export function isGoalStuck(state: GoalDriveState): boolean {
  // blocked_feedback / paused 状态直接视为卡住
  const hasBlockedOrPaused = state.tasks.some(
    t => t.status === 'blocked_feedback' || t.status === 'paused'
  );
  if (hasBlockedOrPaused) return true;

  const hasPending = state.tasks.some(t => t.status === 'pending');
  const hasActive = state.tasks.some(t => t.status === 'dispatched' || t.status === 'running');
  if (!hasPending || hasActive) return false;

  // 有 pending 但没有 active，且没有可派发的 → 卡住
  return getDispatchableTasks(state).length === 0;
}

/** 生成进度摘要 */
export function getProgressSummary(state: GoalDriveState): string {
  const total = state.tasks.length;
  const completed = state.tasks.filter(t => t.status === 'completed').length;
  const running = state.tasks.filter(t => t.status === 'dispatched' || t.status === 'running').length;
  const failed = state.tasks.filter(t => t.status === 'failed').length;
  const blocked = state.tasks.filter(t => t.status === 'blocked').length;

  const parts = [`${completed}/${total} 完成`];
  if (running > 0) parts.push(`${running} 进行中`);
  if (failed > 0) parts.push(`${failed} 失败`);
  if (blocked > 0) parts.push(`${blocked} 待处理`);

  return parts.join(', ');
}
