/**
 * GET /api/status — 全局状态概览
 */

import type { RouteHandler, TaskSummary } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import type { Session } from '../../types/index.js';

function sessionToSummary(s: Session, children: TaskSummary[]): TaskSummary {
  return {
    channel_id: s.channelId,
    name: s.name,
    cwd: s.cwd,
    model: s.model || null,
    has_session: !!s.claudeSessionId,
    message_count: s.messageCount,
    created_at: s.createdAt,
    last_message: s.lastMessage || null,
    last_message_at: s.lastMessageAt || null,
    parent_channel_id: s.parentChannelId || null,
    worktree_branch: s.worktreeBranch || null,
    status: 'active',
    children,
  };
}

function buildTaskTree(sessions: Session[]): TaskSummary[] {
  const liveIds = new Set(sessions.map(s => s.channelId));
  const childMap = new Map<string, Session[]>();

  for (const s of sessions) {
    if (s.parentChannelId && liveIds.has(s.parentChannelId)) {
      const arr = childMap.get(s.parentChannelId) || [];
      arr.push(s);
      childMap.set(s.parentChannelId, arr);
    }
  }

  const topLevel = sessions.filter(s => !s.parentChannelId || !liveIds.has(s.parentChannelId));

  return topLevel.map(s => {
    const children = (childMap.get(s.channelId) || []).map(c => sessionToSummary(c, []));
    return sessionToSummary(s, children);
  });
}

export const getStatus: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const sessions = deps.stateManager.getAllSessions(guildId);
  const defaultCwd = deps.stateManager.getGuildDefaultCwd(guildId);
  const defaultModel = deps.stateManager.getGuildDefaultModel(guildId) || null;

  sendJson(res, 200, {
    ok: true,
    data: {
      default_cwd: defaultCwd,
      default_model: defaultModel,
      active_tasks: sessions.length,
      tasks: buildTaskTree(sessions),
    },
  });
};
