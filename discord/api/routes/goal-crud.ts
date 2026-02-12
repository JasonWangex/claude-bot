/**
 * Goal 元数据 CRUD 路由
 *
 * GET    /api/goals              — 列出 Goals，支持 ?status=&project=&q= 筛选
 * POST   /api/goals              — 创建 Goal
 * GET    /api/goals/:goalId      — Goal 详情（完整 body）
 * PATCH  /api/goals/:goalId      — 更新 Goal（部分更新）
 *
 * 注意: 与 goals.ts 中的 Drive API 路由共存（/api/goals/:goalId/drive 等）
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb, GoalMetaRepo } from '../../db/index.js';
import type { Goal, GoalStatus, GoalType } from '../../types/repository.js';

function getRepo() {
  return new GoalMetaRepo(getDb());
}

/** Goal → API 响应格式 (snake_case) */
function toApiGoal(goal: Goal) {
  return {
    id: goal.id,
    name: goal.name,
    status: goal.status,
    type: goal.type,
    project: goal.project,
    date: goal.date,
    completion: goal.completion,
    progress: goal.progress,
    next: goal.next,
    blocked_by: goal.blockedBy,
    body: goal.body,
  };
}

// GET /api/goals
export const listGoals: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const status = url.searchParams.get('status');
  const project = url.searchParams.get('project');
  const q = url.searchParams.get('q');

  try {
    const repo = getRepo();
    let goals: Goal[];

    if (q) {
      goals = await repo.search(q);
      if (status) goals = goals.filter(g => g.status === status);
      if (project) goals = goals.filter(g => g.project === project);
    } else if (status && project) {
      goals = await repo.findByProject(project);
      goals = goals.filter(g => g.status === status);
    } else if (status) {
      goals = await repo.findByStatus(status as GoalStatus);
    } else if (project) {
      goals = await repo.findByProject(project);
    } else {
      goals = await repo.getAll();
    }

    sendJson(res, 200, { ok: true, data: goals.map(toApiGoal) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list goals: ${error.message}` });
  }
};

// GET /api/goals/:goalId (仅在非 drive/status/pause/resume 子路径时匹配)
export const getGoal: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const goal = await repo.get(params.goalId);
    if (!goal) {
      sendJson(res, 404, { ok: false, error: 'Goal not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: toApiGoal(goal) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get goal: ${error.message}` });
  }
};

interface CreateGoalRequest {
  name: string;
  status?: GoalStatus;
  type?: GoalType;
  project?: string;
  date?: string;
  completion?: string;
  progress?: string;
  next?: string;
  blocked_by?: string;
  body?: string;
}

// POST /api/goals
export const createGoal: RouteHandler = async (req, res) => {
  const body = await readJsonBody<CreateGoalRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  if (!body.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }

  try {
    const repo = getRepo();
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const goal: Goal = {
      id,
      name: body.name.trim(),
      status: body.status || 'Active',
      type: body.type || null,
      project: body.project?.trim() || null,
      date: body.date || new Date().toISOString().slice(0, 10),
      completion: body.completion?.trim() || null,
      progress: body.progress?.trim() || null,
      next: body.next?.trim() || null,
      blockedBy: body.blocked_by?.trim() || null,
      body: body.body || null,
    };

    await repo.save(goal);
    sendJson(res, 201, { ok: true, data: toApiGoal(goal) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create goal: ${error.message}` });
  }
};

interface UpdateGoalRequest {
  name?: string;
  status?: GoalStatus;
  type?: GoalType;
  project?: string;
  date?: string;
  completion?: string;
  progress?: string;
  next?: string;
  blocked_by?: string;
  body?: string;
}

// PATCH /api/goals/:goalId
export const updateGoal: RouteHandler = async (req, res, params) => {
  const updates = await readJsonBody<UpdateGoalRequest>(req);
  if (!updates) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  try {
    const repo = getRepo();
    const existing = await repo.get(params.goalId);
    if (!existing) {
      sendJson(res, 404, { ok: false, error: 'Goal not found' });
      return;
    }

    // 合并更新
    const updated: Goal = {
      id: existing.id,
      name: updates.name?.trim() ?? existing.name,
      status: updates.status ?? existing.status,
      type: updates.type !== undefined ? updates.type : existing.type,
      project: updates.project !== undefined ? updates.project?.trim() ?? null : existing.project,
      date: updates.date ?? existing.date,
      completion: updates.completion !== undefined ? updates.completion?.trim() ?? null : existing.completion,
      progress: updates.progress !== undefined ? updates.progress?.trim() ?? null : existing.progress,
      next: updates.next !== undefined ? updates.next?.trim() ?? null : existing.next,
      blockedBy: updates.blocked_by !== undefined ? updates.blocked_by?.trim() ?? null : existing.blockedBy,
      body: updates.body !== undefined ? updates.body : existing.body,
    };

    await repo.save(updated);
    sendJson(res, 200, { ok: true, data: toApiGoal(updated) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update goal: ${error.message}` });
  }
};
