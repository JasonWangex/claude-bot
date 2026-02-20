/**
 * Task Events 路由
 *
 * POST /api/tasks/:taskId/events  — AI 通过 MCP 写入事件
 *
 * Orchestrator 直接通过 TaskEventRepo 读取，不需要 GET 端点。
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { TaskEventRepo, EVENT_TYPES, type EventType } from '../../db/repo/task-event-repo.js';
import { TaskRepo } from '../../db/repo/index.js';

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
