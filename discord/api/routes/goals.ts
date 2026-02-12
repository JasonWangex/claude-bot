/**
 * Goal API 路由
 *
 * GET  /api/goals                 — 列出 Goals，支持 ?status=&project= 筛选
 * POST /api/goals/:goalId/drive   — 启动 Goal drive
 * GET  /api/goals/:goalId/status  — 查看 drive 状态
 * POST /api/goals/:goalId/pause   — 暂停
 * POST /api/goals/:goalId/resume  — 恢复
 * POST /api/goals/:goalId/tasks/:taskId/skip   — 跳过子任务
 * POST /api/goals/:goalId/tasks/:taskId/done   — 标记手动任务完成
 * POST /api/goals/:goalId/tasks/:taskId/retry  — 重试失败任务
 */

import { stat } from 'fs/promises';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { logger } from '../../utils/logger.js';
import type { StartDriveParams } from '../../orchestrator/index.js';
import { getDb } from '../../db/index.js';
import type { GoalRow } from '../../types/db.js';

/** GoalRow → API 响应格式 */
function toApiGoal(row: GoalRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type,
    project: row.project,
    date: row.date,
    completion: row.completion,
    progress: row.progress,
    next: row.next,
    blocked_by: row.blocked_by,
  };
}

// GET /api/goals
export const listGoals: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const status = url.searchParams.get('status');
  const project = url.searchParams.get('project');

  try {
    const db = getDb();
    let rows: GoalRow[];

    if (status && project) {
      rows = db.prepare('SELECT * FROM goals WHERE status = ? AND project = ? ORDER BY date DESC').all(status, project) as GoalRow[];
    } else if (status) {
      rows = db.prepare('SELECT * FROM goals WHERE status = ? ORDER BY date DESC').all(status) as GoalRow[];
    } else if (project) {
      rows = db.prepare('SELECT * FROM goals WHERE project = ? ORDER BY date DESC').all(project) as GoalRow[];
    } else {
      rows = db.prepare('SELECT * FROM goals ORDER BY date DESC').all() as GoalRow[];
    }

    sendJson(res, 200, { ok: true, data: rows.map(toApiGoal) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list goals: ${error.message}` });
  }
};

// POST /api/goals/:goalId/drive
export const startDrive: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const goalId = params.goalId;

  const body = await readJsonBody<Omit<StartDriveParams, 'goalId'>>(req);
  if (!body?.goalName || !body?.goalThreadId || !body?.baseCwd || !body?.tasks) {
    sendJson(res, 400, {
      ok: false,
      error: 'Required: goalName, goalThreadId, baseCwd, tasks',
    });
    return;
  }

  try {
    const s = await stat(body.baseCwd);
    if (!s.isDirectory()) {
      sendJson(res, 400, { ok: false, error: `baseCwd is not a directory: ${body.baseCwd}` });
      return;
    }
  } catch {
    sendJson(res, 400, { ok: false, error: `baseCwd does not exist: ${body.baseCwd}` });
    return;
  }

  try {
    const state = await deps.orchestrator.startDrive({
      goalId,
      goalName: body.goalName,
      goalThreadId: body.goalThreadId,
      baseCwd: body.baseCwd,
      tasks: body.tasks,
      maxConcurrent: body.maxConcurrent,
    });

    sendJson(res, 200, { ok: true, data: state });
  } catch (err: any) {
    logger.error(`[API] startDrive failed:`, err.message);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// GET /api/goals/:goalId/status
export const getDriveStatus: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const state = await deps.orchestrator.getStatus(params.goalId);
  if (!state) {
    sendJson(res, 404, { ok: false, error: 'No drive found for this goal' });
    return;
  }

  sendJson(res, 200, { ok: true, data: state });
};

// POST /api/goals/:goalId/pause
export const pauseDrive: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.pauseDrive(params.goalId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Drive not running or not found' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'paused' } });
};

// POST /api/goals/:goalId/resume
export const resumeDrive: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.resumeDrive(params.goalId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Drive not paused or not found' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'running' } });
};

// POST /api/goals/:goalId/tasks/:taskId/skip
export const skipTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.skipTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or cannot be skipped' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'skipped' } });
};

// POST /api/goals/:goalId/tasks/:taskId/done
export const markTaskDone: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.markTaskDone(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not blocked' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'completed' } });
};

// POST /api/goals/:goalId/tasks/:taskId/retry
export const retryTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.retryTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not failed' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'pending' } });
};
