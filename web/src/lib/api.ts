const API_BASE = import.meta.env.VITE_API_URL || '';

export async function apiFetch<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.headers) Object.assign(headers, init.headers);
  if (init?.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${endpoint}`, { ...init, headers });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      message = json.error || message;
    } catch {
      const text = await res.text().catch(() => '');
      if (text) message += `: ${text.slice(0, 200)}`;
    }
    throw new Error(message);
  }

  let json: { ok?: boolean; data?: T; error?: string };
  try {
    json = await res.json();
  } catch {
    throw new Error('Invalid JSON response');
  }

  if (!json.ok) throw new Error(json.error || 'API Error');
  return json.data as T;
}

export async function apiPost<T>(endpoint: string, body?: unknown): Promise<T> {
  return apiFetch<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiPatch<T>(endpoint: string, body: unknown): Promise<T> {
  return apiFetch<T>(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function apiDelete(endpoint: string): Promise<void> {
  await apiFetch(endpoint, { method: 'DELETE' });
}
