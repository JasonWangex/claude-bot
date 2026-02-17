/**
 * Task Sessions API
 *
 * GET /api/tasks/:channelId/sessions — 列出指定 task 的所有 claude sessions
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { ClaudeSessionRepository } from '../../db/repo/claude-session-repo.js';

export const listTaskSessions: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  if (!channelId) {
    sendJson(res, 400, { ok: false, error: 'Channel ID required' });
    return;
  }

  const repo = new ClaudeSessionRepository(deps.db);
  const sessions = await repo.getByChannel(channelId);

  const data = sessions.map(s => ({
    id: s.id,
    claude_session_id: s.claudeSessionId || null,
    channel_id: s.channelId || null,
    model: s.model || null,
    status: s.status,
    purpose: s.purpose || null,
    created_at: s.createdAt,
    closed_at: s.closedAt || null,
    last_activity_at: s.lastActivityAt || null,
  }));

  sendJson(res, 200, { ok: true, data });
};
