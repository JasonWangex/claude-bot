/**
 * Session List API
 *
 * GET /api/sessions           — 列出所有 claude sessions（支持分页和状态过滤）
 * GET /api/sessions/:id/meta  — 获取单个 session 元数据
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { ClaudeSessionRepository } from '../../db/repo/claude-session-repo.js';
import { ChannelRepository } from '../../db/repo/channel-repo.js';

export const listSessions: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const statusFilter = url.searchParams.get('status') || 'all';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

  const sessionRepo = new ClaudeSessionRepository(deps.db);
  const channelRepo = new ChannelRepository(deps.db);

  // Load all sessions and filter/paginate in memory
  // (claude_sessions table is typically not huge)
  let allSessions = sessionRepo.loadAll();

  // Sort by created_at DESC
  allSessions.sort((a, b) => b.createdAt - a.createdAt);

  // Filter by status
  if (statusFilter === 'active') {
    allSessions = allSessions.filter(s => s.status === 'active');
  } else if (statusFilter === 'closed') {
    allSessions = allSessions.filter(s => s.status === 'closed');
  }

  const total = allSessions.length;
  const paginated = allSessions.slice(offset, offset + limit);

  // Build channel name map for the sessions in this page
  const channelIds = [...new Set(paginated.map(s => s.channelId).filter(Boolean))] as string[];
  const channelNameMap = new Map<string, string>();
  for (const cid of channelIds) {
    const ch = await channelRepo.get(cid);
    if (ch) channelNameMap.set(cid, ch.name);
  }

  const data = paginated.map(s => ({
    id: s.id,
    claude_session_id: s.claudeSessionId || null,
    channel_id: s.channelId || null,
    channel_name: (s.channelId && channelNameMap.get(s.channelId)) || null,
    title: s.title || null,
    model: s.model || null,
    status: s.status,
    purpose: s.purpose || null,
    created_at: s.createdAt,
    closed_at: s.closedAt || null,
    last_activity_at: s.lastActivityAt || null,
  }));

  sendJson(res, 200, { ok: true, data, total, limit, offset });
};

// GET /api/sessions/:id/meta
export const getSessionMeta: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const sessionId = params.id;
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: 'Session ID required' });
    return;
  }

  const sessionRepo = new ClaudeSessionRepository(deps.db);
  const channelRepo = new ChannelRepository(deps.db);

  const session = await sessionRepo.get(sessionId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Session not found' });
    return;
  }

  let channelName: string | null = null;
  if (session.channelId) {
    const ch = await channelRepo.get(session.channelId);
    if (ch) channelName = ch.name;
  }

  sendJson(res, 200, {
    ok: true,
    data: {
      id: session.id,
      claude_session_id: session.claudeSessionId || null,
      channel_id: session.channelId || null,
      channel_name: channelName,
      title: session.title || null,
      model: session.model || null,
      status: session.status,
      purpose: session.purpose || null,
      created_at: session.createdAt,
      closed_at: session.closedAt || null,
      last_activity_at: session.lastActivityAt || null,
    },
  });
};
