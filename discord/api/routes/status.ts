/**
 * GET /api/status — 全局状态概览
 */

import type { RouteHandler, TaskSummary } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import type { Session } from '../../types/index.js';

function sessionToSummary(s: Session, children: TaskSummary[]): TaskSummary {
  return {
    thread_id: s.threadId,
    name: s.name,
    cwd: s.cwd,
    model: s.model || null,
    has_session: !!s.claudeSessionId,
    message_count: s.messageHistory.length,
    last_active: s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : null,
    parent_thread_id: s.parentThreadId || null,
    worktree_branch: s.worktreeBranch || null,
    children,
  };
}

function buildTaskTree(sessions: Session[]): TaskSummary[] {
  const liveIds = new Set(sessions.map(s => s.threadId));
  const childMap = new Map<string, Session[]>();

  for (const s of sessions) {
    if (s.parentThreadId && liveIds.has(s.parentThreadId)) {
      const arr = childMap.get(s.parentThreadId) || [];
      arr.push(s);
      childMap.set(s.parentThreadId, arr);
    }
  }

  const topLevel = sessions.filter(s => !s.parentThreadId || !liveIds.has(s.parentThreadId));

  return topLevel.map(s => {
    const children = (childMap.get(s.threadId) || []).map(c => sessionToSummary(c, []));
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
