import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { getToken, clearToken } from '@/lib/auth';

export interface SessionSummary {
  id: string;
  claude_session_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  model: string | null;
  status: string;
  purpose: string | null;
  created_at: number;
  closed_at: number | null;
  last_activity_at: number | null;
}

export interface SessionEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'queue-operation';
  subtype?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  parent_tool_use_id?: string;
  total_cost_usd?: number;
  cwd?: string;
  version?: string;
}

export function useTaskSessions(channelId: string | null) {
  return useSWR<SessionSummary[]>(
    channelId ? `/api/tasks/${channelId}/sessions` : null,
    apiFetch,
  );
}

export function useSessions(status?: 'active' | 'closed' | 'all', limit = 50, offset = 0) {
  const query = new URLSearchParams();
  if (status && status !== 'all') query.set('status', status);
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
