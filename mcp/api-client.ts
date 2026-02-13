/**
 * Bot API HTTP 客户端
 *
 * 封装对 http://127.0.0.1:3456/api/* 的调用，供 MCP 工具使用。
 */

const API_BASE = process.env.BOT_API_BASE || 'http://127.0.0.1:3456';

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function apiGet<T = unknown>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  return res.json() as Promise<ApiResult<T>>;
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return res.json() as Promise<ApiResult<T>>;
}

export async function apiPatch<T = unknown>(path: string, body: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return res.json() as Promise<ApiResult<T>>;
}

export async function apiDelete<T = unknown>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
  return res.json() as Promise<ApiResult<T>>;
}

/**
 * 检查 Bot API 是否可达
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const r = await apiGet('/api/health');
    return r.ok === true;
  } catch {
    return false;
  }
}
