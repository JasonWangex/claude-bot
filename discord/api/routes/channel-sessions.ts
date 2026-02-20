/**
 * Channel Sessions API
 *
 * GET /api/channels/:channelId/sessions — 列出指定 channel 的所有 claude sessions
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { ClaudeSessionRepository } from '../../db/repo/claude-session-repo.js';

export const listChannelSessions: RouteHandler = async (_req, res, params, deps) => {
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
    claude_session_id: s.claudeSessionId,
    channel_id: s.channelId || null,
    model: s.model || null,
    status: s.status,
    purpose: s.purpose || null,
    title: s.title || null,
    created_at: s.createdAt,
    closed_at: s.closedAt || null,
    last_activity_at: s.lastActivityAt || null,
    tokens_in: s.tokensIn || 0,
    tokens_out: s.tokensOut || 0,
    cache_read_in: s.cacheReadIn || 0,
    cache_write_in: s.cacheWriteIn || 0,
    cost_usd: s.costUsd || 0,
    turn_count: s.turnCount || 0,
  }));

  sendJson(res, 200, { ok: true, data });
};
