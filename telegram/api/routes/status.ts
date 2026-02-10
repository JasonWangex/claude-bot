/**
 * GET /api/status         — 全局状态概览
 * GET /api/usage          — 今日 Token 用量
 * GET /api/usage/:date    — 指定日期用量 (yesterday | YYYY-MM-DD)
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

export const getUsage: RouteHandler = async (_req, res, params, deps) => {
  requireAuth(res);

  const dateParam = params.date;
  let stats;
  let dateLabel: string;

  if (!dateParam) {
    stats = await deps.usageReader.getTodayStats();
    dateLabel = 'today';
  } else if (dateParam === 'yesterday') {
    stats = await deps.usageReader.getYesterdayStats();
    dateLabel = 'yesterday';
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    stats = await deps.usageReader.getDailyStats(dateParam);
    dateLabel = dateParam;
  } else {
    sendJson(res, 400, {
      ok: false,
      error: 'Invalid date. Use "yesterday" or "YYYY-MM-DD".',
    });
    return;
  }

  if (!stats) {
    sendJson(res, 404, { ok: false, error: `No usage data for ${dateLabel}` });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    data: {
      date: stats.date,
      message_count: stats.messageCount,
      session_count: stats.sessionCount,
      total_tokens: stats.totalTokens,
      total_cost: stats.totalCost,
      models: stats.models,
      cache_stats: {
        total_read_tokens: stats.cacheStats.totalReadTokens,
        total_write_tokens: stats.cacheStats.totalWriteTokens,
        savings_usd: stats.cacheStats.savingsUSD,
        hit_rate: stats.cacheStats.hitRate,
      },
    },
  });
};
