/**
 * Goal 任务重规划器
 *
 * 当子任务反馈 feedback (type=replan/blocked/clarify) 时，
 * 构建 replan prompt 并调用 LLM 生成结构化变更指令。
 *
 * 核心约束：已完成任务（completed/skipped）不可修改。
 */

import type { GoalDriveState, GoalTask, GoalTaskFeedback } from '../types/index.js';
import type { Goal, IGoalTaskRepo, IGoalMetaRepo } from '../types/repository.js';
import { chatCompletion } from '../utils/llm.js';
import { execGit } from './git-ops.js';
import { logger } from '../utils/logger.js';

// ==================== 类型定义 ====================

/** 单条变更指令 */
export type ReplanChange =
  | { action: 'add'; task: { id: string; description: string; type: string; depends: string[]; phase?: number } }
  | { action: 'modify'; taskId: string; updates: { description?: string; type?: string; depends?: string[]; phase?: number } }
  | { action: 'remove'; taskId: string; reason: string }
  | { action: 'reorder'; taskId: string; newDepends: string[]; newPhase?: number };

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
}

/** 应用变更后的结果 */
export interface ApplyResult {
  applied: ReplanChange[];
  rejected: Array<{ change: ReplanChange; reason: string }>;
  updatedTasks: GoalTask[];
}

// ==================== 主入口 ====================

/**
 * 执行任务重规划：构建 prompt → 调用 LLM → 解析变更 → 校验约束
 *
 * @returns ReplanResult（未应用），调用者负责决定是否 apply
 */
export async function replanTasks(ctx: ReplanContext): Promise<ReplanResult | null> {
  const prompt = buildReplanPrompt(ctx);

  logger.info(`[Replanner] Generating replan for goal ${ctx.state.goalId}, trigger: ${ctx.triggerTaskId}`);

  const raw = await chatCompletion(prompt, {
    maxTokens: 4096,
    temperature: 0.2,
    timeout: 30_000,
  });

  if (!raw) {
    logger.warn('[Replanner] LLM returned empty response');
    return null;
  }

  const result = parseReplanResponse(raw);
  if (!result) {
    logger.warn('[Replanner] Failed to parse LLM response');
    return null;
  }

  // 过滤掉违反约束的变更（已完成任务不可修改）
  const completedIds = new Set(
    ctx.state.tasks
      .filter(t => t.status === 'completed' || t.status === 'skipped')
      .map(t => t.id)
  );
  result.changes = result.changes.filter(change => {
    const targetId = 'taskId' in change ? change.taskId : null;
    if (targetId && completedIds.has(targetId)) {
      logger.warn(`[Replanner] Rejected change: cannot modify completed task ${targetId}`);
      return false;
    }
    return true;
  });

  return result;
}

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
        // 验证依赖引用有效
        const invalidDeps = change.task.depends.filter(d => !taskMap.has(d));
        if (invalidDeps.length > 0) {
          rejected.push({ change, reason: `Invalid depends: ${invalidDeps.join(', ')}` });
          break;
        }
        const newTask: GoalTask = {
          id: change.task.id,
          description: change.task.description,
          type: (change.task.type as GoalTask['type']) || '代码',
          depends: change.task.depends,
          phase: change.task.phase,
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
        // 验证新依赖引用有效
        if (change.updates.depends) {
          const invalidDeps = change.updates.depends.filter(d => !taskMap.has(d));
          if (invalidDeps.length > 0) {
            rejected.push({ change, reason: `Invalid depends: ${invalidDeps.join(', ')}` });
            break;
          }
        }
        if (change.updates.description) task.description = change.updates.description;
        if (change.updates.type) task.type = change.updates.type as GoalTask['type'];
        if (change.updates.depends) task.depends = change.updates.depends;
        if (change.updates.phase !== undefined) task.phase = change.updates.phase;
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

      case 'reorder': {
        const task = taskMap.get(change.taskId);
        if (!task) {
          rejected.push({ change, reason: `Task ${change.taskId} not found` });
          break;
        }
        if (immutableStatuses.has(task.status)) {
          rejected.push({ change, reason: `Cannot reorder task in ${task.status} status` });
          break;
        }
        // 验证新依赖引用有效
        const invalidReorderDeps = change.newDepends.filter(d => !taskMap.has(d));
        if (invalidReorderDeps.length > 0) {
          rejected.push({ change, reason: `Invalid depends: ${invalidReorderDeps.join(', ')}` });
          break;
        }
        task.depends = change.newDepends;
        if (change.newPhase !== undefined) task.phase = change.newPhase;
        applied.push(change);
        break;
      }
    }
  }

  return { applied, rejected, updatedTasks };
}

// ==================== 依赖一致性验证 ====================

/** 依赖验证结果 */
export interface DependencyValidation {
  valid: boolean;
  errors: string[];
}

/**
 * 验证任务图的依赖一致性：
 * 1. 所有依赖引用的任务必须存在（非 cancelled）
 * 2. 不能存在循环依赖
 */
export function validateDependencies(tasks: GoalTask[]): DependencyValidation {
  const errors: string[] = [];
  const activeTaskIds = new Set(
    tasks.filter(t => t.status !== 'cancelled').map(t => t.id),
  );

  // 1. 检查悬空引用（忽略 cancelled 任务的依赖）
  for (const task of tasks) {
    if (task.status === 'cancelled') continue;
    for (const dep of task.depends) {
      if (!activeTaskIds.has(dep)) {
        errors.push(`Task ${task.id} depends on non-existent/cancelled task ${dep}`);
      }
    }
  }

  // 2. 检查循环依赖（DFS 拓扑排序）
  const cycle = detectCycle(tasks.filter(t => t.status !== 'cancelled'));
  if (cycle) {
    errors.push(`Circular dependency detected: ${cycle.join(' → ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * DFS 检测循环依赖，返回环路径或 null
 */
function detectCycle(tasks: GoalTask[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    adj.set(task.id, task.depends);
  }

  // 0 = unvisited, 1 = in stack (visiting), 2 = done
  const state = new Map<string, 0 | 1 | 2>();
  for (const task of tasks) state.set(task.id, 0);

  const path: string[] = [];

  function dfs(nodeId: string): string[] | null {
    const s = state.get(nodeId);
    if (s === 2) return null;  // already fully processed
    if (s === 1) {
      // Found cycle — extract the cycle path
      const cycleStart = path.indexOf(nodeId);
      return [...path.slice(cycleStart), nodeId];
    }

    state.set(nodeId, 1);
    path.push(nodeId);

    for (const dep of adj.get(nodeId) ?? []) {
      if (!adj.has(dep)) continue; // skip refs to non-existent tasks (handled separately)
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }

    path.pop();
    state.set(nodeId, 2);
    return null;
  }

  for (const task of tasks) {
    const cycle = dfs(task.id);
    if (cycle) return cycle;
  }
  return null;
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
    '| ID | 类型 | 描述 | 依赖 | 状态 |',
    '|---|---|---|---|---|',
  ];

  for (const task of tasks) {
    const emoji = statusEmoji[task.status] || '';
    const deps = task.depends.length > 0 ? task.depends.join(', ') : '—';
    const desc = task.description.replace(/\|/g, '\\|');
    lines.push(`| ${task.id} | ${task.type} | ${desc} | ${deps} | ${emoji} ${task.status} |`);
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

  // 匹配 "## 子任务" 到下一个 ## 或文件末尾
  const sectionRegex = /## 子任务[\s\S]*?(?=\n## [^子]|\n## $|$)/;
  if (sectionRegex.test(body)) {
    return body.replace(sectionRegex, taskSection);
  }

  // 没有现有子任务段落 → 追加
  return body.trimEnd() + '\n\n' + taskSection;
}

// ==================== applyChanges() 完整流程 ====================

/** applyChanges 的依赖参数 */
export interface ApplyChangesDeps {
  goalTaskRepo: IGoalTaskRepo;
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

  // 2. 验证依赖一致性
  const validation = validateDependencies(result.updatedTasks);
  if (!validation.valid) {
    logger.warn(`[Replanner] Dependency validation failed: ${validation.errors.join('; ')}`);
    // 依赖验证失败不阻止持久化，但记录错误供调用者处理
  }

  // 3. 更新内存 state
  state.tasks = result.updatedTasks;
  state.updatedAt = Date.now();

  // 4. 持久化到 GoalTaskRepo
  await deps.goalTaskRepo.saveAll(state.goalId, result.updatedTasks);

  // 5. 更新 Goal body
  const goalMeta = await deps.goalMetaRepo.get(state.goalId);
  if (goalMeta) {
    goalMeta.body = updateGoalBodyWithTasks(goalMeta.body, result.updatedTasks);
    // 更新进度信息
    const completed = result.updatedTasks.filter(t => t.status === 'completed').length;
    const active = result.updatedTasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
    goalMeta.progress = `${completed}/${active} 子任务完成`;
    await deps.goalMetaRepo.save(goalMeta);
  }

  logger.info(
    `[Replanner] Applied ${result.applied.length} changes, rejected ${result.rejected.length}` +
    (validation.errors.length > 0 ? `, validation warnings: ${validation.errors.length}` : ''),
  );

  return { ...result, validationErrors: validation.errors };
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

function buildReplanPrompt(ctx: ReplanContext): string {
  const { state, goalMeta, triggerTaskId, feedback, completedDiffStats } = ctx;

  const lines: string[] = [];

  // 1. 角色与任务说明
  lines.push(
    `You are a task replanner for a software development goal orchestrator.`,
    `Your job is to analyze feedback from a subtask and produce a structured JSON plan update.`,
    ``,
  );

  // 2. Goal 描述
  lines.push(`## Goal`);
  lines.push(`Name: ${state.goalName}`);
  if (goalMeta?.body) {
    lines.push(`Description:`);
    lines.push(goalMeta.body.slice(0, 2000));
  }
  if (goalMeta?.completion) {
    lines.push(`Completion criteria: ${goalMeta.completion}`);
  }
  lines.push(``);

  // 3. 当前任务全景（含状态）
  lines.push(`## Current Tasks`);
  for (const task of state.tasks) {
    const deps = task.depends.length > 0 ? ` [depends: ${task.depends.join(', ')}]` : '';
    const phase = task.phase != null ? ` (phase ${task.phase})` : '';
    lines.push(`- ${task.id}: [${task.status}] ${task.type} — ${task.description}${deps}${phase}`);
  }
  lines.push(``);

  // 4. 触发 replan 的原因和 feedback 内容
  lines.push(`## Replan Trigger`);
  lines.push(`Task: ${triggerTaskId}`);
  lines.push(`Feedback type: ${feedback.type}`);
  lines.push(`Reason: ${feedback.reason}`);
  if (feedback.details) {
    lines.push(`Details:`);
    const detailStr = typeof feedback.details === 'string'
      ? feedback.details
      : JSON.stringify(feedback.details, null, 2);
    lines.push(detailStr.slice(0, 3000));
  }
  lines.push(``);

  // 5. 已完成任务的产出摘要
  if (completedDiffStats.size > 0) {
    lines.push(`## Completed Task Output (git diff stat)`);
    for (const [taskId, stat] of completedDiffStats) {
      const task = state.tasks.find(t => t.id === taskId);
      lines.push(`### ${taskId}: ${task?.description ?? 'unknown'}`);
      lines.push('```');
      lines.push(stat.slice(0, 500));
      lines.push('```');
    }
    lines.push(``);
  }

  // 6. 约束
  lines.push(
    `## Constraints`,
    `1. **NEVER modify completed or skipped tasks** — their IDs: ${
      state.tasks.filter(t => t.status === 'completed' || t.status === 'skipped').map(t => t.id).join(', ') || 'none'
    }`,
    `2. **NEVER modify running or dispatched tasks** — their IDs: ${
      state.tasks.filter(t => t.status === 'running' || t.status === 'dispatched').map(t => t.id).join(', ') || 'none'
    }`,
    `3. New task IDs must not collide with existing IDs`,
    `4. Dependencies must reference valid task IDs (existing or newly added)`,
    `5. Keep changes minimal — only modify what the feedback necessitates`,
    `6. Preserve the overall goal direction`,
    ``,
  );

  // 7. 输出格式
  lines.push(
    `## Output Format`,
    `Respond with a single JSON object (no markdown fences, no extra text):`,
    ``,
    `{`,
    `  "changes": [`,
    `    { "action": "add", "task": { "id": "t8", "description": "...", "type": "代码", "depends": ["t3"], "phase": 3 } },`,
    `    { "action": "modify", "taskId": "t5", "updates": { "description": "new desc", "depends": ["t3", "t8"] } },`,
    `    { "action": "remove", "taskId": "t7", "reason": "superseded by t8" },`,
    `    { "action": "reorder", "taskId": "t6", "newDepends": ["t8"], "newPhase": 3 }`,
    `  ],`,
    `  "reasoning": "Explanation of why these changes are needed",`,
    `  "impactLevel": "low" | "medium" | "high"`,
    `}`,
    ``,
    `Impact levels:`,
    `- low: minor adjustments (description tweaks, dependency reorder)`,
    `- medium: task additions/removals that don't change the overall direction`,
    `- high: significant restructuring, new phases, or direction change`,
    ``,
    `Valid task types: 代码, 手动, 调研, 占位`,
    `Valid actions: add, modify, remove, reorder`,
    ``,
    `If no changes are needed, return: { "changes": [], "reasoning": "...", "impactLevel": "low" }`,
  );

  return lines.join('\n');
}

// ==================== 响应解析 ====================

function parseReplanResponse(raw: string): ReplanResult | null {
  try {
    // 尝试直接解析
    let json = raw.trim();

    // 移除可能的 markdown 代码块包裹
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(json);

    // 校验必须字段
    if (!Array.isArray(parsed.changes)) {
      logger.warn('[Replanner] Invalid response: changes is not an array');
      return null;
    }
    if (typeof parsed.reasoning !== 'string') {
      logger.warn('[Replanner] Invalid response: reasoning is not a string');
      return null;
    }

    const validImpactLevels = ['low', 'medium', 'high'];
    const impactLevel = validImpactLevels.includes(parsed.impactLevel)
      ? parsed.impactLevel
      : 'medium';

    // 校验每个 change 的结构
    const validChanges: ReplanChange[] = [];
    for (const change of parsed.changes) {
      if (!change.action) continue;

      switch (change.action) {
        case 'add':
          if (change.task?.id && change.task?.description) {
            validChanges.push({
              action: 'add',
              task: {
                id: change.task.id,
                description: change.task.description,
                type: change.task.type || '代码',
                depends: Array.isArray(change.task.depends) ? change.task.depends : [],
                phase: change.task.phase,
              },
            });
          }
          break;

        case 'modify':
          if (change.taskId && change.updates) {
            validChanges.push({
              action: 'modify',
              taskId: change.taskId,
              updates: change.updates,
            });
          }
          break;

        case 'remove':
          if (change.taskId) {
            validChanges.push({
              action: 'remove',
              taskId: change.taskId,
              reason: change.reason || 'removed by replanner',
            });
          }
          break;

        case 'reorder':
          if (change.taskId && Array.isArray(change.newDepends)) {
            validChanges.push({
              action: 'reorder',
              taskId: change.taskId,
              newDepends: change.newDepends,
              newPhase: change.newPhase,
            });
          }
          break;
      }
    }

    return {
      changes: validChanges,
      reasoning: parsed.reasoning,
      impactLevel,
    };
  } catch (err: any) {
    logger.warn(`[Replanner] JSON parse failed: ${err.message}`);
    return null;
  }
}
