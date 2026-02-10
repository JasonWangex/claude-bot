/**
 * POST /api/topics/:topicId/clear    — 清空 Claude 上下文
 * POST /api/topics/:topicId/compact  — 压缩上下文
 * POST /api/topics/:topicId/rewind   — 撤销最后一轮
 * POST /api/topics/:topicId/stop     — 停止当前任务
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { StateManager } from '../../bot/state.js';

export const clearSession: RouteHandler = async (_req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  deps.stateManager.clearSessionClaudeId(groupId, topicId);

  sendJson(res, 200, {
    ok: true,
    data: { success: true, message: 'Session cleared' },
  });
};

export const compactSession: RouteHandler = async (_req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  if (!session.claudeSessionId) {
    sendJson(res, 400, { ok: false, error: 'No active Claude session to compact' });
    return;
  }

  try {
    const lockKey = StateManager.topicLockKey(groupId, topicId);
    const result = await deps.claudeClient.compact(session.claudeSessionId, session.cwd, lockKey);

    sendJson(res, 200, {
      ok: true,
      data: { success: true, session_id: result.sessionId },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Compact failed: ${error.message}` });
  }
};

export const rewindSession: RouteHandler = async (_req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const result = deps.stateManager.rewindSession(groupId, topicId);
  if (!result.success) {
    sendJson(res, 400, { ok: false, error: result.reason });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    data: { success: true, message: 'Rewound to previous turn' },
  });
};

export const stopSession: RouteHandler = async (_req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const lockKey = StateManager.topicLockKey(groupId, topicId);
  const wasRunning = deps.claudeClient.abort(lockKey);

  sendJson(res, 200, {
    ok: true,
    data: {
      success: true,
      message: wasRunning ? 'Task stopped' : 'No running task',
    },
  });
};
