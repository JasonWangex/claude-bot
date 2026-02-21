/**
 * Goal Tasks 路由
 *
 * POST /api/goals/:goalId/tasks  — 批量写入初始任务（drive 启动前由 Claude 调用）
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { TaskRepo } from '../../db/repo/index.js';
import { GoalMetaRepo } from '../../db/goal-meta-repo.js';
import type { Task } from '../../types/index.js';

interface SetTasksRequest {
  tasks: Array<{
    id: string;
    description: string;
    type?: string;
    phase?: number;
    complexity?: string;
  }>;
}

const VALID_TYPES = ['代码', '手动', '调研', '占位'] as const;
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
  const goalRepo = new GoalMetaRepo(db);
  const goal = await goalRepo.get(goalId);
  if (!goal) {
    sendJson(res, 404, { ok: false, error: `Goal not found: ${goalId}` });
    return;
  }

  // drive 进行中时禁止覆盖
  if (goal.driveStatus === 'running' || goal.driveStatus === 'paused') {
    sendJson(res, 409, {
      ok: false,
      error: `Cannot overwrite tasks while drive is ${goal.driveStatus}`,
    });
    return;
  }

  const tasks: Task[] = body.tasks.map(t => ({
    id: t.id,
    goalId,
    description: t.description,
    type: (VALID_TYPES.includes(t.type as ValidType) ? t.type : '代码') as ValidType,
    phase: t.phase ?? 1,
    complexity: (t.complexity === 'simple' || t.complexity === 'complex')
      ? t.complexity
      : undefined,
    status: 'pending',
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
