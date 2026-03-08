/**
 * Goal Tasks 路由
 *
 * POST   /api/goals/:goalId/tasks           — 批量写入初始任务
 * POST   /api/goals/:goalId/tasks/add       — 添加单个任务
 * PATCH  /api/goals/:goalId/tasks/:taskId   — 修改任务字段
 * DELETE /api/goals/:goalId/tasks/:taskId   — 取消任务（设 status=cancelled）
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { TaskRepo } from '../../db/repo/index.js';
import { GoalRepo } from '../../db/repo/index.js';
import type { Task } from '../../types/index.js';
import { TaskStatus, TaskType, TaskComplexity } from '../../types/index.js';

interface SetTasksRequest {
  tasks: Array<{
    id: string;
    description: string;
    type?: string;
    phase?: number;
    complexity?: string;
  }>;
}

const VALID_TYPES = [TaskType.Code, TaskType.Manual, TaskType.Research, TaskType.Placeholder, TaskType.Test] as const;
type ValidType = typeof VALID_TYPES[number];

// POST /api/goals/:goalId/tasks
export const setGoalTasks: RouteHandler = async (req, res, params) => {
  const { goalId } = params;

  const body = await readJsonBody<SetTasksRequest>(req);
  if (!body?.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Required: tasks (non-empty array)' });
    return;
  }

  const ids = body.tasks.map(t => t.id);
  if (new Set(ids).size !== ids.length) {
    sendJson(res, 400, { ok: false, error: 'Task IDs must be unique' });
    return;
  }

  const db = getDb();

  // 确认 goal 存在
  const goalRepo = new GoalRepo(db);
  const goal = await goalRepo.getMeta(goalId);
  if (!goal) {
    sendJson(res, 404, { ok: false, error: `Goal not found: ${goalId}` });
    return;
  }

  const tasks: Task[] = body.tasks.map(t => ({
    id: t.id,
    goalId,
    description: t.description,
    type: (VALID_TYPES.includes(t.type as ValidType) ? t.type : TaskType.Code) as ValidType,
    phase: t.phase ?? 1,
    complexity: (t.complexity === TaskComplexity.Simple || t.complexity === TaskComplexity.Complex)
      ? t.complexity as TaskComplexity
      : undefined,
    status: TaskStatus.Pending,
    merged: false,
    notifiedBlocked: false,
    auditRetries: 0,
  }));

  try {
    const taskRepo = new TaskRepo(db);
    await taskRepo.saveAll(tasks, goalId);
    sendJson(res, 200, { ok: true, data: { count: tasks.length } });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

interface AddTaskRequest {
  id: string;
  description: string;
  type?: string;
  phase?: number;
  complexity?: string;
}

// POST /api/goals/:goalId/tasks/add
export const addGoalTask: RouteHandler = async (req, res, params) => {
  const { goalId } = params;
  const body = await readJsonBody<AddTaskRequest>(req);
  if (!body?.id || !body?.description) {
    sendJson(res, 400, { ok: false, error: 'Required: id, description' });
    return;
  }

  const db = getDb();
  const goalRepo = new GoalRepo(db);
  const goal = await goalRepo.getMeta(goalId);
  if (!goal) {
    sendJson(res, 404, { ok: false, error: `Goal not found: ${goalId}` });
    return;
  }

  const task: Task = {
    id: body.id,
    goalId,
    description: body.description,
    type: (VALID_TYPES.includes(body.type as ValidType) ? body.type : TaskType.Code) as ValidType,
    phase: body.phase ?? 1,
    complexity: (body.complexity === TaskComplexity.Simple || body.complexity === TaskComplexity.Complex)
      ? body.complexity as TaskComplexity
      : undefined,
    status: TaskStatus.Pending,
    merged: false,
    notifiedBlocked: false,
    auditRetries: 0,
  };

  try {
    const taskRepo = new TaskRepo(db);
    const existing = await taskRepo.getAllByGoal(goalId);
    const duplicate = existing.find(t => t.id === body.id);
    if (duplicate) {
      sendJson(res, 409, { ok: false, error: `Task ID already exists: ${body.id}` });
      return;
    }
    await taskRepo.saveAll([...existing, task], goalId);
    sendJson(res, 200, { ok: true, data: task });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

interface UpdateTaskRequest {
  description?: string;
  type?: string;
  phase?: number;
  complexity?: string;
}

// PATCH /api/goals/:goalId/tasks/:taskId
export const updateGoalTask: RouteHandler = async (req, res, params) => {
  const { goalId, taskId } = params;
  const body = await readJsonBody<UpdateTaskRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  const db = getDb();
  const taskRepo = new TaskRepo(db);
  const tasks = await taskRepo.getAllByGoal(goalId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
    return;
  }

  if (body.description !== undefined) task.description = body.description;
  if (body.type !== undefined && VALID_TYPES.includes(body.type as ValidType)) {
    task.type = body.type as ValidType;
  }
  if (body.phase !== undefined) task.phase = body.phase;
  if (body.complexity !== undefined) {
    task.complexity = (body.complexity === TaskComplexity.Simple || body.complexity === TaskComplexity.Complex)
      ? body.complexity as TaskComplexity
      : undefined;
  }

  try {
    await taskRepo.saveAll(tasks, goalId);
    sendJson(res, 200, { ok: true, data: task });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// DELETE /api/goals/:goalId/tasks/:taskId
export const removeGoalTask: RouteHandler = async (_req, res, params) => {
  const { goalId, taskId } = params;

  const db = getDb();
  const taskRepo = new TaskRepo(db);
  const tasks = await taskRepo.getAllByGoal(goalId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
    return;
  }

  task.status = TaskStatus.Cancelled;

  try {
    await taskRepo.saveAll(tasks, goalId);
    sendJson(res, 200, { ok: true, data: { status: TaskStatus.Cancelled } });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};
