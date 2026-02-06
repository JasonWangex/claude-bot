import type { WebSocket } from 'ws';

// Persisted to data/sessions.json
export interface SessionMeta {
  id: string;           // UUID
  tmuxName: string;     // "cw-" + first 8 chars of id
  name: string;         // User-readable name
  cwd: string;          // Working directory
  createdAt: number;
}

// Runtime = meta + alive status
export interface Session extends SessionMeta {
  alive: boolean;
}

// API response to frontend
export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
}

export interface CreateSessionRequest {
  name: string;
}

export interface AuthPayload {
  iat: number;
  exp: number;
}

export interface WebSocketClient extends WebSocket {
  isAlive?: boolean;
  sessionId?: string;
}

// IM API types
export interface SendInputRequest {
  text: string;
}

export interface ScreenResponse {
  content: string;
}
