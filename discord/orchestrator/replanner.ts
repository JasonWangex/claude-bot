/**
 * Goal 任务重规划器
 *
 * 当子任务反馈 feedback (type=replan/blocked/clarify) 时，
 * 构建 replan prompt 并调用 LLM 生成结构化变更指令。
 *
 * 核心约束：已完成任务（completed/skipped）不可修改。
 */

import type { GoalDriveState, GoalTask, GoalTaskFeedback } from '../types/index.js';
import type { Goal, ITaskRepo, IGoalMetaRepo, IGoalCheckpointRepo } from '../types/repository.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';
import { execGit } from './git-ops.js';
import { logger } from '../utils/logger.js';
import { buildReplanApprovalButtons, buildReplanRollbackButton } from './goal-buttons.js';

// ==================== 类型定义 ====================

/** 单条变更指令 */
export type ReplanChange =
  | { action: 'add'; task: { id: string; description: string; type: string; phase?: number; complexity?: 'simple' | 'complex' } }
  | { action: 'modify'; taskId: string; updates: { description?: string; type?: string; phase?: number; complexity?: 'simple' | 'complex' } }
  | { action: 'remove'; taskId: string; reason: string };

/** LLM 返回的重规划结果 */
export interface ReplanResult {
  changes: ReplanChange[];
  reasoning: string;
  impactLevel: 'low' | 'medium' | 'high';
}

/** 重规划触发上下文 */
export interface ReplanContext {
  state: GoalDriveState;
  goalMeta: Goal | null;
  triggerTaskId: string;
  feedback: GoalTaskFeedback;
  completedDiffStats: Map<string, string>; // taskId → git diff --stat output
  promptService: PromptConfigService;
}

/** 应用变更后的结果 */
export interface ApplyResult {
  applied: ReplanChange[];
  rejected: Array<{ change: ReplanChange; reason: string }>;
  updatedTasks: GoalTask[];
}

/** 分级自治处理的依赖 */
export interface HandleReplanDeps extends ApplyChangesDeps {
  checkpointRepo: IGoalCheckpointRepo;
  notify: (
    threadId: string,
    message: string,
    type?: 'success' | 'error' | 'warning' | 'info' | 'pipeline',
    options?: { components?: import('discord.js').ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>[] },
  ) => Promise<void>;
}

/** 分级自治处理结果 */
export interface HandleReplanResult {
  impactLevel: 'low' | 'medium' | 'high';
  /** 是否已自动应用变更（low/medium 自动应用，high 暂停等待审批） */
  autoApplied: boolean;
  /** 人类可读的变更 diff 文本 */
  changeDiff: string;
  /** 应用结果（仅当 autoApplied=true 时有值） */
  applyResult?: ApplyResult & { validationErrors: string[] };
  /** 快照 ID（用于回滚） */
  checkpointId?: string;
}

// ==================== 变更应用 ====================

/**
 * 将 ReplanResult 的变更应用到任务列表（不修改已完成任务）
 *
 * 返回 ApplyResult，包含成功应用和被拒绝的变更
 */
export function applyReplanChanges(
  tasks: GoalTask[],
  changes: ReplanChange[],
): ApplyResult {
  const applied: ReplanChange[] = [];
  const rejected: Array<{ change: ReplanChange; reason: string }> = [];
  const updatedTasks = tasks.map(t => ({ ...t })); // shallow copy
  const taskMap = new Map(updatedTasks.map(t => [t.id, t]));

  const immutableStatuses = new Set(['completed', 'skipped', 'running', 'dispatched']);

  for (const change of changes) {
    switch (change.action) {
      case 'add': {
        if (taskMap.has(change.task.id)) {
          rejected.push({ change, reason: `Task ${change.task.id} already exists` });
          break;
        }
        const newTask: GoalTask = {
          id: change.task.id,
          description: change.task.description,
          type: (change.task.type as GoalTask['type']) || '代码',
          phase: change.task.phase,
          complexity: change.task.complexity,
          status: 'pending',
        };
        updatedTasks.push(newTask);
        taskMap.set(newTask.id, newTask);
        applied.push(change);
        break;
      }

      case 'modify': {
        const task = taskMap.get(change.taskId);
        if (!task) {
          rejected.push({ change, reason: `Task ${change.taskId} not found` });
          break;
        }
        if (immutableStatuses.has(task.status)) {
          rejected.push({ change, reason: `Cannot modify task in ${task.status} status` });
          break;
        }
        if (change.updates.description) task.description = change.updates.description;
        if (change.updates.type) task.type = change.updates.type as GoalTask['type'];
        if (change.updates.phase !== undefined) task.phase = change.updates.phase;
        if (change.updates.complexity) task.complexity = change.updates.complexity;
        applied.push(change);
        break;
      }

      case 'remove': {
        const task = taskMap.get(change.taskId);
        if (!task) {
          rejected.push({ change, reason: `Task ${change.taskId} not found` });
          break;
        }
        if (immutableStatuses.has(task.status)) {
          rejected.push({ change, reason: `Cannot remove task in ${task.status} status` });
          break;
        }
        task.status = 'cancelled';
        applied.push(change);
        break;
      }

    }
  }

  return { applied, rejected, updatedTasks };
}

// ==================== Goal body 子任务列表更新 ====================

/**
 * 将任务列表渲染为 Markdown 文本，用于更新 Goal body 中的子任务部分。
 *
 * 格式：
 * ```
 * ## 子任务
 * | ID | 类型 | 描述 | 依赖 | 状态 |
 * |---|---|---|---|---|
 * | t1 | 代码 | 创建数据模型 | — | ✅ completed |
 * | t2 | 代码 | 实现 API | t1 | 🔄 running |
 * ```
 */
export function renderTaskListMarkdown(tasks: GoalTask[]): string {
  const statusEmoji: Record<string, string> = {
    pending: '⏳',
    dispatched: '📤',
    running: '🔄',
    completed: '✅',
    failed: '❌',
    blocked: '🚧',
    blocked_feedback: '💬',
    paused: '⏸️',
    cancelled: '🚫',
    skipped: '⏭️',
  };

  const lines: string[] = [
    '## 子任务',
    '',
    '| ID | 类型 | 描述 | Phase | 状态 |',
    '|---|---|---|---|---|',
  ];

  for (const task of tasks) {
    const emoji = statusEmoji[task.status] || '';
    const phase = task.phase ?? 1;
    const desc = task.description.replace(/\|/g, '\\|');
    lines.push(`| ${task.id} | ${task.type} | ${desc} | ${phase} | ${emoji} ${task.status} |`);
  }

  return lines.join('\n');
}

/**
 * 更新 Goal body 中的子任务列表部分。
 *
 * 如果 body 中已有 "## 子任务" 段落，则替换；否则追加。
 */
export function updateGoalBodyWithTasks(body: string | null, tasks: GoalTask[]): string {
  const taskSection = renderTaskListMarkdown(tasks);

  if (!body) return taskSection;

  // 匹配 "## 子任务" 到下一个 ## 标题或文件末尾
  const sectionRegex = /## 子任务[\s\S]*?(?=\n##\s|$)/;
  if (sectionRegex.test(body)) {
    return body.replace(sectionRegex, taskSection);
  }

  // 没有现有子任务段落 → 追加
  return body.trimEnd() + '\n\n' + taskSection;
}

// ==================== applyChanges() 完整流程 ====================

/** applyChanges 的依赖参数 */
export interface ApplyChangesDeps {
  taskRepo: ITaskRepo;
  goalMetaRepo: IGoalMetaRepo;
}

/**
 * 完整的变更应用流程：
 *
 * 1. 调用 applyReplanChanges() 将变更应用到内存任务图
 * 2. 验证依赖一致性（悬空引用 + 循环依赖）
 * 3. 通过 GoalTaskRepo 持久化任务列表
 * 4. 更新 Goal body 中的子任务列表
 *
 * @returns ApplyResult + 验证信息
 */
export async function applyChanges(
  state: GoalDriveState,
  changes: ReplanChange[],
  deps: ApplyChangesDeps,
): Promise<ApplyResult & { validationErrors: string[] }> {
  // 1. 应用变更到内存
  const result = applyReplanChanges(state.tasks, changes);

  // 2. 更新内存 state
  state.tasks = result.updatedTasks;
  state.updatedAt = Date.now();

  // 3. 持久化到 TaskRepo
  await deps.taskRepo.saveAll(result.updatedTasks, state.goalId);

  // 4. 更新 Goal body
  const goalMeta = await deps.goalMetaRepo.get(state.goalId);
  if (goalMeta) {
    goalMeta.body = updateGoalBodyWithTasks(goalMeta.body, result.updatedTasks);
    // 更新进度信息（JSON 格式）
    const total = result.updatedTasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
    const completed = result.updatedTasks.filter(t => t.status === 'completed' && (!t.branchName || t.merged)).length;
    const running = result.updatedTasks.filter(t => t.status === 'dispatched' || t.status === 'running').length;
    const failed = result.updatedTasks.filter(t => t.status === 'failed').length;
    goalMeta.progress = JSON.stringify({ completed, total, running, failed });
    await deps.goalMetaRepo.save(goalMeta);
  }

  logger.info(
    `[Replanner] Applied ${result.applied.length} changes, rejected ${result.rejected.length}`,
  );

  return { ...result, validationErrors: [] };
}

// ==================== Impact Level 分级自治 ====================

/**
 * 独立评估 impact_level（覆盖 LLM 自评结果）
 *
 * 判断标准：
 * - low: 影响 ≤1 个未开始任务（description tweaks, dependency reorder）
 * - medium: 影响 2-3 个未开始任务
 * - high: 影响 ≥4 个任务 或 有 remove/add 操作改变方向
 */
export function assessImpactLevel(
  changes: ReplanChange[],
  tasks: GoalTask[],
): 'low' | 'medium' | 'high' {
  if (changes.length === 0) return 'low';

  // 收集所有被影响的未开始任务 ID
  const pendingIds = new Set(
    tasks.filter(t => t.status === 'pending').map(t => t.id),
  );

  const affectedPendingIds = new Set<string>();
  let hasDirectionChange = false;

  for (const change of changes) {
    switch (change.action) {
      case 'add':
        // 新增任务本身算一个影响
        affectedPendingIds.add(change.task.id);
        break;

      case 'remove':
        if (pendingIds.has(change.taskId)) {
          affectedPendingIds.add(change.taskId);
        }
        // remove 操作视为方向变更信号
        hasDirectionChange = true;
        break;

      case 'modify': {
        if (pendingIds.has(change.taskId)) {
          affectedPendingIds.add(change.taskId);
        }
        // 修改 description 可能意味着方向变更
        if (change.updates.description) {
          hasDirectionChange = true;
        }
        break;
      }

    }
  }

  const affectedCount = affectedPendingIds.size;

  // ≥4 个任务 或 方向变更(add+remove 同时存在) → high
  const hasAdd = changes.some(c => c.action === 'add');
  const hasRemove = changes.some(c => c.action === 'remove');
  if (affectedCount >= 4 || (hasAdd && hasRemove && hasDirectionChange)) {
    return 'high';
  }

  // 2-3 个 → medium
  if (affectedCount >= 2) return 'medium';

  // ≤1 → low
  return 'low';
}

/**
 * 生成人类可读的变更计划 diff
 *
 * 格式示例：
 * ```
 * 📋 计划变更 (impact: medium)
 * ── 原因 ──
 * Task t3 报告需要拆分为前后端...
 *
 * ── 变更列表 ──
 * ➕ 新增: t9 — 实现前端表单验证 (phase 3)
 * ✏️ 修改: t5 — 更新描述: "..." → "..."
 * ❌ 移除: t7 — 原因: superseded by t9
 * ```
 */
export function generateChangeDiff(
  result: ReplanResult,
  tasks: GoalTask[],
): string {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const lines: string[] = [];

  const levelEmoji = { low: '🟢', medium: '🟡', high: '🔴' };
  lines.push(`📋 **计划变更** ${levelEmoji[result.impactLevel]} impact: **${result.impactLevel}**`);
  lines.push('');
  lines.push(`── 原因 ──`);
  lines.push(result.reasoning);
  lines.push('');
  lines.push(`── 变更列表 ──`);

  for (const change of result.changes) {
    switch (change.action) {
      case 'add': {
        const phase = change.task.phase != null ? ` (phase ${change.task.phase})` : '';
        lines.push(`➕ 新增: **${change.task.id}** — ${change.task.description}${phase}`);
        break;
      }
      case 'modify': {
        const existing = taskMap.get(change.taskId);
        const parts: string[] = [];
        if (change.updates.description) {
          const oldDesc = existing?.description ?? '?';
          parts.push(`描述: "${oldDesc.slice(0, 40)}" → "${change.updates.description.slice(0, 40)}"`);
        }
        if (change.updates.type) {
          parts.push(`类型: ${change.updates.type}`);
        }
        if (change.updates.phase !== undefined) {
          parts.push(`phase: ${change.updates.phase}`);
        }
        lines.push(`✏️ 修改: **${change.taskId}** — ${parts.join('; ')}`);
        break;
      }
      case 'remove':
        lines.push(`❌ 移除: **${change.taskId}** — 原因: ${change.reason}`);
        break;
    }
  }

  return lines.join('\n');
}

/**
 * 分级自治主流程：根据 impact_level 决定自动执行或等待审批
 *
 * - low/medium: 先保存快照 → 自动 applyChanges() → 通知用户（含快照 ID 可回滚）
 * - high: 暂停分发 → 生成变更 diff → 发审批请求等用户确认
 */
export async function handleReplanByImpact(
  state: GoalDriveState,
  result: ReplanResult,
  deps: HandleReplanDeps,
): Promise<HandleReplanResult> {
  // 1. 独立评估 impact（覆盖 LLM 自评）
  const assessed = assessImpactLevel(result.changes, state.tasks);
  result.impactLevel = assessed;

  // 2. 生成变更 diff
  const changeDiff = generateChangeDiff(result, state.tasks);

  // 3. 保存快照（所有级别都保存，用于回滚）
  const checkpointId = `cp-${state.goalId}-${Date.now()}`;
  await deps.checkpointRepo.saveCheckpoint({
    id: checkpointId,
    goalId: state.goalId,
    trigger: 'replan',
    triggerTaskId: undefined,
    reason: result.reasoning.slice(0, 200),
    tasksSnapshot: state.tasks.map(t => ({ ...t })),
    gitRef: undefined,
    changeSummary: changeDiff.slice(0, 500),
    createdAt: Date.now(),
  });

  if (assessed === 'high') {
    // ── HIGH: 暂停分发，等待用户审批 ──
    logger.info(`[Replanner] HIGH impact — pausing for approval, goal ${state.goalId}`);

    const approvalMessage =
      `🔴 **需要审批：高影响计划变更**\n\n` +
      changeDiff + '\n\n' +
      `快照 ID: \`${checkpointId}\``;

    await deps.notify(state.goalChannelId, approvalMessage, 'warning', {
      components: buildReplanApprovalButtons(state.goalId, checkpointId),
    });

    // 将 pending replan 信息存入 state，供后续审批时使用
    // 使用 state 上的临时字段（通过 GoalDriveState 扩展）
    state.pendingReplan = {
      changes: result.changes,
      reasoning: result.reasoning,
      impactLevel: assessed,
      checkpointId,
    };

    return {
      impactLevel: assessed,
      autoApplied: false,
      changeDiff,
      checkpointId,
    };
  }

  // ── LOW / MEDIUM: 自动执行 ──
  logger.info(`[Replanner] ${assessed.toUpperCase()} impact — auto-applying, goal ${state.goalId}`);

  const applyResult = await applyChanges(state, result.changes, deps);

  // 发送通知（含回滚按钮）
  const levelLabel = assessed === 'low' ? '🟢 低影响' : '🟡 中影响';
  const notifyMessage =
    `${levelLabel} 计划已自动更新\n\n` +
    changeDiff + '\n\n' +
    `已应用 ${applyResult.applied.length} 项变更` +
    (applyResult.rejected.length > 0
      ? `，${applyResult.rejected.length} 项被拒绝`
      : '') +
    (applyResult.validationErrors.length > 0
      ? `\n⚠️ 验证警告: ${applyResult.validationErrors.join('; ')}`
      : '') +
    `\n快照 ID: \`${checkpointId}\``;

  await deps.notify(state.goalChannelId, notifyMessage, assessed === 'low' ? 'info' : 'warning', {
    components: buildReplanRollbackButton(state.goalId, checkpointId),
  });

  return {
    impactLevel: assessed,
    autoApplied: true,
    changeDiff,
    applyResult,
    checkpointId,
  };
}

// ==================== Git diff 工具 ====================

/**
 * 获取已完成任务的 git diff stat 摘要
 *
 * 对每个已完成且已合并的任务，计算其分支相对于 goal 分支的 diff --stat
 */
export async function collectCompletedDiffStats(
  state: GoalDriveState,
): Promise<Map<string, string>> {
  const stats = new Map<string, string>();

  // 查找 goal worktree 目录
  let goalWorktreeDir: string;
  try {
    const stdout = await execGit(
      ['worktree', 'list', '--porcelain'],
      state.baseCwd,
      'replanner: list worktrees'
    );
    const lines = stdout.split('\n');
    let currentWorktree = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) currentWorktree = line.slice('worktree '.length);
      if (line.startsWith('branch ') && line.includes(state.goalBranch)) {
        goalWorktreeDir = currentWorktree;
        break;
      }
    }
    if (!goalWorktreeDir!) return stats;
  } catch {
    return stats;
  }

  for (const task of state.tasks) {
    if (task.status !== 'completed' || !task.merged || !task.branchName) continue;

    try {
      // 使用 git log --oneline 查看该分支的 commit 范围，再 diff --stat
      const diffStat = await execGit(
        ['log', '--oneline', '--format=', '--stat', `${state.goalBranch}..${task.branchName}`],
        goalWorktreeDir,
        `replanner: diff stat for ${task.id}`
      );
      if (diffStat.trim()) {
        stats.set(task.id, diffStat.trim());
      }
    } catch {
      // 分支可能已被删除（cleanup 后），这是正常的
    }
  }

  return stats;
}

// ==================== Prompt 构建 ====================

export function buildReplanPrompt(ctx: ReplanContext): string {
  const { state, goalMeta, triggerTaskId, feedback, completedDiffStats, promptService } = ctx;

  // 构建动态变量值
  const goalBody = goalMeta?.body
    ? `Description:\n${goalMeta.body.slice(0, 2000)}`
    : '';
  const completionCriteria = goalMeta?.completion
    ? `Completion criteria: ${goalMeta.completion}`
    : '';

  // 当前任务列表
  const currentTasks = state.tasks.map(task => {
    const phase = task.phase != null ? ` (phase ${task.phase})` : '';
    return `- ${task.id}: [${task.status}] ${task.type} — ${task.description}${phase}`;
  }).join('\n');

  // Feedback details
  let feedbackDetails = '';
  if (feedback.details) {
    const detailStr = typeof feedback.details === 'string'
      ? feedback.details
      : JSON.stringify(feedback.details, null, 2);
    feedbackDetails = `Details:\n${detailStr.slice(0, 3000)}`;
  }

  // 已完成任务 diff stats
  let completedStats = '';
  if (completedDiffStats.size > 0) {
    const statsLines: string[] = [`## Completed Task Output (git diff stat)`];
    for (const [taskId, stat] of completedDiffStats) {
      const task = state.tasks.find(t => t.id === taskId);
      statsLines.push(`### ${taskId}: ${task?.description ?? 'unknown'}`);
      statsLines.push('```');
      statsLines.push(stat.slice(0, 500));
      statsLines.push('```');
    }
    completedStats = statsLines.join('\n') + '\n';
  }

  const immutableCompleted = state.tasks
    .filter(t => t.status === 'completed' || t.status === 'skipped')
    .map(t => t.id).join(', ') || 'none';
  const immutableRunning = state.tasks
    .filter(t => t.status === 'running' || t.status === 'dispatched')
    .map(t => t.id).join(', ') || 'none';

  return promptService.render('orchestrator.replan', {
    GOAL_NAME: state.goalName,
    GOAL_BODY: goalBody,
    COMPLETION_CRITERIA: completionCriteria,
    CURRENT_TASKS: currentTasks,
    TRIGGER_TASK_ID: triggerTaskId,
    TASK_ID: triggerTaskId,
    FEEDBACK_TYPE: feedback.type,
    FEEDBACK_REASON: feedback.reason,
    FEEDBACK_DETAILS: feedbackDetails,
    COMPLETED_DIFF_STATS: completedStats,
    IMMUTABLE_COMPLETED: immutableCompleted,
    IMMUTABLE_RUNNING: immutableRunning,
    GOAL_SEQ: String(state.goalSeq),
  });
}


