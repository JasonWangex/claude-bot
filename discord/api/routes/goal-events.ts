/**
 * Goal Events 路由
 *
 * POST /api/goals/:goalId/events — Claude skill 写入 goal 级别事件
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { GoalEventRepo, GoalEventType } from '../../db/repo/goal-event-repo.js';

interface CreateGoalEventRequest {
  event_type: string;
  payload?: Record<string, unknown>;
}

// POST /api/goals/:goalId/events
export const createGoalEvent: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<CreateGoalEventRequest>(req);
  if (!body?.event_type) {
    sendJson(res, 400, { ok: false, error: 'Required: event_type' });
    return;
  }

  if (!Object.values(GoalEventType).includes(body.event_type as GoalEventType)) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid event_type. Must be one of: ${Object.values(GoalEventType).join(', ')}`,
    });
    return;
  }

  // event_type 特定 payload 校验
  if (body.event_type === GoalEventType.Drive) {
    const p = body.payload ?? {};
    if (!p.goalName || !p.goalChannelId || !p.baseCwd) {
      sendJson(res, 400, {
        ok: false,
        error: 'goal.drive payload requires: goalName, goalChannelId, baseCwd',
      });
      return;
    }
  }

  try {
    const repo = new GoalEventRepo(getDb());
    repo.write(params.goalId, body.event_type as GoalEventType, body.payload ?? {});
    sendJson(res, 201, { ok: true, data: { goal_id: params.goalId, event_type: body.event_type } });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};
