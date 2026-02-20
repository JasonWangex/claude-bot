/**
 * Channel 共享工具函数
 *
 * sessionToSummary / buildChannelTree 被 channels.ts 和 status.ts 共用
 */

import type { ChannelSummary } from '../types.js';
import type { Session } from '../../types/index.js';

export function sessionToSummary(s: Session, children: ChannelSummary[]): ChannelSummary {
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

export function buildChannelTree(sessions: Session[]): ChannelSummary[] {
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
