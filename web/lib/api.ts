const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3456';

export async function apiFetch<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
  if (init?.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${endpoint}`, { ...init, headers });

  if (!res.ok) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      throw new Error(json.error || `HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message !== text) throw e;
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API Error');
  return json.data;
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
