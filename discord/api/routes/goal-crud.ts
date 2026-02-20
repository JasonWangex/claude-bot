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

const VALID_STATUSES: GoalStatus[] = ['Pending', 'Collecting', 'Planned', 'Processing', 'Blocking', 'Completed', 'Merged'];
const VALID_TYPES: GoalType[] = ['探索型', '交付型'];

/** 合法的状态转换 */
const VALID_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  Pending:    ['Collecting'],
  Collecting: ['Planned', 'Pending'],
  Planned:    ['Processing', 'Collecting'],
  Processing: ['Completed', 'Blocking'],
  Blocking:   ['Processing', 'Completed'],
  Completed:  ['Merged', 'Processing'],
  Merged:     [],
};

function getRepo() {
  return new GoalMetaRepo(getDb());
}

/** 解析 progress 字段：JSON 格式 → 结构化对象，旧文本格式 → 兼容解析 */
function parseProgress(raw: string | null): { completed: number; total: number; running: number; failed: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.completed === 'number' && typeof parsed.total === 'number') {
      return { completed: parsed.completed, total: parsed.total, running: parsed.running ?? 0, failed: parsed.failed ?? 0 };
    }
  } catch { /* not JSON, try legacy format */ }
  // 兼容旧格式 "3/5 子任务完成"
  const match = raw.match(/(\d+)\s*\/\s*(\d+)/);
  if (match) return { completed: parseInt(match[1], 10), total: parseInt(match[2], 10), running: 0, failed: 0 };
  return null;
}

/** Goal → API 响应格式 (snake_case) */
function toApiGoal(goal: Goal) {
  return {
    id: goal.id,
    seq: goal.seq,
    name: goal.name,
    status: goal.status,
    type: goal.type,
    project: goal.project,
    date: goal.date,
    completion: goal.completion,
    progress: parseProgress(goal.progress),
    next: goal.next,
    blocked_by: goal.blockedBy,
    body: goal.body,
    drive_status: goal.driveStatus,
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

  if (body.status && !VALID_STATUSES.includes(body.status)) {
    sendJson(res, 400, { ok: false, error: `Invalid status. Valid values: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  if (body.type && !VALID_TYPES.includes(body.type)) {
    sendJson(res, 400, { ok: false, error: `Invalid type. Valid values: ${VALID_TYPES.join(', ')}` });
    return;
  }

  try {
    const repo = getRepo();
    const { randomUUID } = await import('crypto');
    const id = randomUUID();

    const goal: Goal = {
      id,
      name: body.name.trim(),
      status: body.status || 'Pending',
      type: body.type || null,
      project: body.project?.trim() || null,
      date: body.date || new Date().toISOString().slice(0, 10),
      completion: body.completion?.trim() || null,
      progress: body.progress?.trim() || null,
      next: body.next?.trim() || null,
      blockedBy: body.blocked_by?.trim() || null,
      body: body.body || null,
      seq: null,  // auto-assigned by DB (MAX(seq) + 1)
      driveStatus: null,
    };

    await repo.save(goal);
    // Re-read to get the auto-assigned seq
    const saved = await repo.get(id);
    sendJson(res, 201, { ok: true, data: toApiGoal(saved || goal) });
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

  if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
    sendJson(res, 400, { ok: false, error: `Invalid status. Valid values: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  if (updates.type !== undefined && updates.type !== null && !VALID_TYPES.includes(updates.type)) {
    sendJson(res, 400, { ok: false, error: `Invalid type. Valid values: ${VALID_TYPES.join(', ')}` });
    return;
  }

  try {
    const repo = getRepo();
    const existing = await repo.get(params.goalId);
    if (!existing) {
      sendJson(res, 404, { ok: false, error: 'Goal not found' });
      return;
    }

    // 状态转换校验
    if (updates.status && updates.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status];
      if (!allowed?.includes(updates.status)) {
        sendJson(res, 400, {
          ok: false,
          error: `Invalid status transition: ${existing.status} → ${updates.status}. Allowed: ${allowed?.join(', ') || 'none (terminal state)'}`,
        });
        return;
      }
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
      seq: existing.seq,
      driveStatus: existing.driveStatus,
    };

    await repo.save(updated);
    sendJson(res, 200, { ok: true, data: toApiGoal(updated) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update goal: ${error.message}` });
  }
};
