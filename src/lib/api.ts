const API_BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('token');
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Login failed');
  }
  const { token } = await res.json();
  localStorage.setItem('token', token);
  return token;
}

export function logout() {
  localStorage.removeItem('token');
}

export function isLoggedIn(): boolean {
  const token = getToken();
  if (!token) return false;
  try {
    // Decode JWT payload without verification to check expiry
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem('token');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
}

export async function getSessions(): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/sessions`, {
    headers: authHeaders(),
  });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

export async function createSession(name: string): Promise<SessionInfo> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create session');
  }
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error('Failed to delete session');
}

export function getWsUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/ws?sessionId=${sessionId}`;
}

export function getAuthToken(): string | null {
  return getToken();
}
