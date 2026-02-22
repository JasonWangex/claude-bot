import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { getToken, clearToken } from '@/lib/auth';

export interface SessionSummary {
  claude_session_id: string;
  channel_id: string | null;
  channel_name: string | null;
  model: string | null;
  status: string;
  purpose: string | null;
  title: string | null;
  created_at: number;
  closed_at: number | null;
  last_activity_at: number | null;
  task_id: string | null;
  goal_id: string | null;
  task_description: string | null;
  pipeline_phase: string | null;
  goal_name: string | null;
  goal_project: string | null;
  cwd: string | null;
  git_branch: string | null;
  project_path: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_in: number;
  cache_write_in: number;
  cost_usd: number;
  turn_count: number;
  model_usage: Record<string, {
    tokensIn: number;
    tokensOut: number;
    cacheReadIn: number;
    cacheWriteIn: number;
    costUsd: number;
    turnCount: number;
  }> | null;
  hidden: boolean;
}

// ========== JSONL Event Types (matching Claude Code format) ==========

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | { type: string; [key: string]: unknown };

export interface SessionEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'progress' | 'file-history-snapshot';
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  userType?: string; // 'external' | 'internal'
  cwd?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    type?: string;
    content?: ContentBlock[] | string;
    stop_reason?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  // progress event
  data?: {
    type?: string;
    message?: { type: string; message?: SessionEvent['message']; uuid?: string; timestamp?: string };
    prompt?: string;
    agentId?: string;
  };
}

export function useChannelSessions(channelId: string | null) {
  return useSWR<SessionSummary[]>(
    channelId ? `/api/channels/${channelId}/sessions` : null,
    apiFetch,
  );
}

export function useSessions(status?: 'active' | 'closed' | 'all', limit = 1000, offset = 0, goalId?: string, includeHidden = false) {
  const query = new URLSearchParams();
  if (status && status !== 'all') query.set('status', status);
  if (goalId) query.set('goal_id', goalId);
  if (includeHidden) query.set('include_hidden', 'true');
  query.set('limit', String(limit));
  query.set('offset', String(offset));
  const qs = query.toString();
  return useSWR<SessionSummary[]>(
    `/api/sessions?${qs}`,
    apiFetch,
    { refreshInterval: 10000 },
  );
}

/** Fetch a session's conversation JSONL as parsed events */
export async function fetchSessionConversation(sessionId: string): Promise<SessionEvent[]> {
  const API_BASE = import.meta.env.VITE_API_URL || '';
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/conversation`, { headers });
  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const text = await res.text();
  const events: SessionEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}
