/**
 * POST /api/channels/:channelId/clear    — 清空 Claude 上下文
 * POST /api/channels/:channelId/compact  — 压缩上下文
 * POST /api/channels/:channelId/rewind   — 撤销最后一轮
 * POST /api/channels/:channelId/stop     — 停止当前任务
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { StateManager } from '../../bot/state.js';

export const clearSession: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  deps.stateManager.clearSessionClaudeId(guildId, channelId);

  sendJson(res, 200, {
    ok: true,
    data: { success: true, message: 'Session cleared' },
  });
};

export const compactSession: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  if (!session.claudeSessionId) {
    sendJson(res, 400, { ok: false, error: 'No active Claude session to compact' });
    return;
  }

  try {
    const lockKey = StateManager.channelLockKey(guildId, channelId);
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
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const result = deps.stateManager.rewindSession(guildId, channelId);
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
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const lockKey = StateManager.channelLockKey(guildId, channelId);
  const wasRunning = deps.claudeClient.abort(lockKey);

  sendJson(res, 200, {
    ok: true,
    data: {
      success: true,
      message: wasRunning ? 'Task stopped' : 'No running task',
    },
  });
};
