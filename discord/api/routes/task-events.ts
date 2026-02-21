/**
 * Task Events 路由
 *
 * GET  /api/events                — 列出所有事件（支持筛选）
 * POST /api/tasks/:taskId/events  — AI 通过 MCP 写入事件
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { TaskEventRepo, EVENT_TYPES, type EventType } from '../../db/repo/task-event-repo.js';
import { TaskRepo } from '../../db/repo/index.js';

// GET /api/events
export const listTaskEvents: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const goalId = url.searchParams.get('goalId') || undefined;
  const taskId = url.searchParams.get('taskId') || undefined;
  const eventType = url.searchParams.get('type') || undefined;
  const onlyPending = url.searchParams.get('pending') === 'true';
  const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
  const size = parseInt(url.searchParams.get('size') || '50', 10) || 50;

  try {
    const eventRepo = new TaskEventRepo(getDb());
    const result = eventRepo.findAll({ goalId, taskId, eventType, onlyPending, page, size });
    sendJson(res, 200, { ok: true, data: result });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list events: ${error.message}` });
  }
};

interface CreateTaskEventRequest {
  event_type: string;
  payload: Record<string, unknown>;
  source?: 'ai';
}

// POST /api/tasks/:taskId/events
export const createTaskEvent: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<CreateTaskEventRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  const { event_type, payload } = body;

  if (!event_type || !EVENT_TYPES.includes(event_type as EventType)) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid event_type. Must be one of: ${EVENT_TYPES.join(', ')}`,
    });
    return;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { ok: false, error: '"payload" must be an object' });
    return;
  }

  const { taskId } = params;

  try {
    const db = getDb();
    const taskRepo = new TaskRepo(db);
    const task = await taskRepo.getById(taskId);
    if (!task) {
      sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
      return;
    }

    const eventRepo = new TaskEventRepo(db);
    eventRepo.write(taskId, task.goalId ?? null, event_type as EventType, payload, 'ai');

    sendJson(res, 201, { ok: true, data: { task_id: taskId, event_type, recorded: true } });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to record event: ${error.message}` });
  }
};
