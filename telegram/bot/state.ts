/**
 * 用户状态管理
 */

import { UserState } from '../types/index.js';

export class StateManager {
  private states: Map<number, UserState>;
  private defaultWorkDir: string;

  constructor(defaultWorkDir: string) {
    this.states = new Map();
    this.defaultWorkDir = defaultWorkDir;
  }

  get(userId: number): UserState {
    if (!this.states.has(userId)) {
      this.states.set(userId, {
        cwd: this.defaultWorkDir,
        lastActivity: Date.now(),
        authorized: false,
      });
    }

    const state = this.states.get(userId)!;
    state.lastActivity = Date.now();
    return state;
  }

  setAuthorized(userId: number, authorized: boolean): void {
    const state = this.get(userId);
    state.authorized = authorized;
  }

  isAuthorized(userId: number): boolean {
    const state = this.get(userId);
    return state.authorized;
  }

  setCwd(userId: number, cwd: string): void {
    const state = this.get(userId);
    state.cwd = cwd;
  }

  setSessionId(userId: number, sessionId: string): void {
    const state = this.get(userId);
    state.sessionId = sessionId;
  }

  clearSession(userId: number): void {
    const state = this.get(userId);
    state.sessionId = undefined;
  }

  cleanup(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const [userId, state] of this.states.entries()) {
      if (now - state.lastActivity > maxAge) {
        this.states.delete(userId);
      }
    }
  }

  getActiveCount(): number {
    return this.states.size;
  }
}
