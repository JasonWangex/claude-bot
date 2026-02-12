/**
 * Goals CRUD API 路由
 *
 * GET    /api/goals           — 列出所有 Goals，支持 ?status= &project= 筛选
 * POST   /api/goals           — 创建 Goal
 * GET    /api/goals/:goalId   — 获取 Goal 详情（含 tasks）
 * PATCH  /api/goals/:goalId   — 更新 Goal 元数据
 */

import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import type { RouteHandler } from '../types.js';
import type {
  GoalSummary,
  GoalDetail,
  GoalTaskSummary,
  CreateGoalRequest,
  UpdateGoalRequest,
} from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { logger } from '../../utils/logger.js';
import { getDb } from '../../db/index.js';
import type { GoalRow, GoalTaskRow, GoalTaskDepRow, GoalStatus, GoalType } from '../../types/db.js';

// ==================== 常量 ====================

const VALID_STATUSES: GoalStatus[] = ['Idea', 'Active', 'Paused', 'Done', 'Abandoned'];
const VALID_TYPES: GoalType[] = ['探索型', '交付型'];

// ==================== 辅助函数 ====================

function getQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.searchParams;
}

function goalRowToSummary(row: GoalRow): GoalSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type,
    project: row.project,
    date: row.date,
    progress: row.progress,
    drive_status: row.drive_status,
  };
}

function goalRowToDetail(
  row: GoalRow,
  taskRows: GoalTaskRow[],
  depRows: GoalTaskDepRow[],
): GoalDetail {
  // 构建 taskId → depends 映射
  const depsMap = new Map<string, string[]>();
  for (const dep of depRows) {
    const list = depsMap.get(dep.task_id) || [];
    list.push(dep.depends_on_task_id);
    depsMap.set(dep.task_id, list);
  }

  const tasks: GoalTaskSummary[] = taskRows.map((t) => ({
    id: t.id,
    description: t.description,
    type: t.type,
    phase: t.phase,
    status: t.status,
    depends: depsMap.get(t.id) || [],
    branch_name: t.branch_name,
    thread_id: t.thread_id,
  }));

  return {
    ...goalRowToSummary(row),
    completion: row.completion,
    next: row.next,
    blocked_by: row.blocked_by,
    body: row.body,
    drive_branch: row.drive_branch,
    drive_thread_id: row.drive_thread_id,
    drive_base_cwd: row.drive_base_cwd,
    drive_max_concurrent: row.drive_max_concurrent,
    drive_created_at: row.drive_created_at,
    drive_updated_at: row.drive_updated_at,
    tasks,
  };
}

// ==================== GET /api/goals ====================

export const listGoals: RouteHandler = async (req, res) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  try {
    const db = getDb();
    const query = getQueryParams(req);
    const statusFilter = query.get('status');
    const projectFilter = query.get('project');

    // 校验 status 参数
    if (statusFilter && !VALID_STATUSES.includes(statusFilter as GoalStatus)) {
      sendJson(res, 400, {
        ok: false,
        error: `Invalid status filter. Valid values: ${VALID_STATUSES.join(', ')}`,
      });
      return;
    }

    // 动态构建查询
    let sql = 'SELECT * FROM goals';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statusFilter) {
      conditions.push('status = ?');
      params.push(statusFilter);
    }
    if (projectFilter) {
      conditions.push('project = ?');
      params.push(projectFilter);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY date DESC, name ASC';

    const rows = db.prepare(sql).all(...params) as GoalRow[];
    const data: GoalSummary[] = rows.map(goalRowToSummary);

    sendJson(res, 200, { ok: true, data });
  } catch (err: any) {
    logger.error('[API] listGoals failed:', err.message);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// ==================== POST /api/goals ====================

export const createGoal: RouteHandler = async (req, res) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const body = await readJsonBody<CreateGoalRequest>(req);
  if (!body?.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }

  const name = body.name.trim();
  if (!name || name.length > 200) {
    sendJson(res, 400, { ok: false, error: 'Name must be 1-200 characters' });
    return;
  }

  // 校验 status
  const status: GoalStatus = body.status || 'Active';
  if (!VALID_STATUSES.includes(status)) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid status. Valid values: ${VALID_STATUSES.join(', ')}`,
    });
    return;
  }

  // 校验 type
  if (body.type && !VALID_TYPES.includes(body.type)) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid type. Valid values: ${VALID_TYPES.join(', ')}`,
    });
    return;
  }

  try {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString().slice(0, 10); // yyyy-MM-dd

    db.prepare(`
      INSERT INTO goals (id, name, status, type, project, date, completion, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      status,
      body.type ?? null,
      body.project ?? null,
      now,
      body.completion ?? null,
      body.body ?? null,
    );

    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow;

    sendJson(res, 201, { ok: true, data: goalRowToSummary(row) });
  } catch (err: any) {
    logger.error('[API] createGoal failed:', err.message);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// ==================== GET /api/goals/:goalId ====================

export const getGoal: RouteHandler = async (_req, res, params) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(params.goalId) as GoalRow | undefined;
    if (!row) {
      sendJson(res, 404, { ok: false, error: 'Goal not found' });
      return;
    }

    const taskRows = db.prepare(
      'SELECT * FROM goal_tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC',
    ).all(params.goalId) as GoalTaskRow[];

    const depRows = db.prepare(
      'SELECT * FROM goal_task_deps WHERE goal_id = ?',
    ).all(params.goalId) as GoalTaskDepRow[];

    sendJson(res, 200, { ok: true, data: goalRowToDetail(row, taskRows, depRows) });
  } catch (err: any) {
    logger.error('[API] getGoal failed:', err.message);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// ==================== PATCH /api/goals/:goalId ====================

export const updateGoal: RouteHandler = async (req, res, params) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const body = await readJsonBody<UpdateGoalRequest>(req);
  if (!body || Object.keys(body).length === 0) {
    sendJson(res, 400, { ok: false, error: 'Request body is required' });
    return;
  }

  // 校验 name
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200) {
      sendJson(res, 400, { ok: false, error: 'Name must be 1-200 characters' });
      return;
    }
  }

  // 校验 status
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid status. Valid values: ${VALID_STATUSES.join(', ')}`,
    });
    return;
  }

  // 校验 type
  if (body.type !== undefined && !VALID_TYPES.includes(body.type)) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid type. Valid values: ${VALID_TYPES.join(', ')}`,
    });
    return;
  }

  try {
    const db = getDb();

    // 确认 goal 存在
    const existing = db.prepare('SELECT id FROM goals WHERE id = ?').get(params.goalId);
    if (!existing) {
      sendJson(res, 404, { ok: false, error: 'Goal not found' });
      return;
    }

    // 允许更新的字段
    const allowedFields: (keyof UpdateGoalRequest)[] = [
      'name', 'status', 'type', 'project', 'date',
      'completion', 'progress', 'next', 'blocked_by', 'body',
    ];

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (setClauses.length === 0) {
      sendJson(res, 400, { ok: false, error: 'No valid fields to update' });
      return;
    }

    values.push(params.goalId);
    db.prepare(`UPDATE goals SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    // 返回更新后的完整数据
    const updated = db.prepare('SELECT * FROM goals WHERE id = ?').get(params.goalId) as GoalRow;
    const taskRows = db.prepare(
      'SELECT * FROM goal_tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC',
    ).all(params.goalId) as GoalTaskRow[];
    const depRows = db.prepare(
      'SELECT * FROM goal_task_deps WHERE goal_id = ?',
    ).all(params.goalId) as GoalTaskDepRow[];

    sendJson(res, 200, { ok: true, data: goalRowToDetail(updated, taskRows, depRows) });
  } catch (err: any) {
    logger.error('[API] updateGoal failed:', err.message);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};
