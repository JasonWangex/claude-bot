/**
 * GET /api/status         — 全局状态概览
 */

import type { RouteHandler, TopicSummary } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import type { Session } from '../../types/index.js';

function sessionToSummary(s: Session, children: TopicSummary[]): TopicSummary {
  return {
    topic_id: s.topicId,
    name: s.name,
    cwd: s.cwd,
    model: s.model || null,
    has_session: !!s.claudeSessionId,
    message_count: s.messageHistory.length,
    last_active: s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : null,
    parent_topic_id: s.parentTopicId || null,
    worktree_branch: s.worktreeBranch || null,
    children,
  };
}

function buildTopicTree(sessions: Session[]): TopicSummary[] {
  const liveIds = new Set(sessions.map(s => s.topicId));
  const childMap = new Map<number, Session[]>();

  for (const s of sessions) {
    if (s.parentTopicId && liveIds.has(s.parentTopicId)) {
      const arr = childMap.get(s.parentTopicId) || [];
      arr.push(s);
      childMap.set(s.parentTopicId, arr);
    }
  }

  const topLevel = sessions.filter(s => !s.parentTopicId || !liveIds.has(s.parentTopicId));

  return topLevel.map(s => {
    const children = (childMap.get(s.topicId) || []).map(c => sessionToSummary(c, []));
    return sessionToSummary(s, children);
  });
}

export const getStatus: RouteHandler = async (_req, res, _params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const sessions = deps.stateManager.getAllSessions(groupId);
  const defaultCwd = deps.stateManager.getGroupDefaultCwd(groupId);
  const defaultModel = deps.stateManager.getGroupDefaultModel(groupId) || null;

  sendJson(res, 200, {
    ok: true,
    data: {
      default_cwd: defaultCwd,
      default_model: defaultModel,
      active_topics: sessions.length,
      topics: buildTopicTree(sessions),
    },
  });
};

