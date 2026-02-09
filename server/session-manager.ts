import { spawnSync, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Session, SessionMeta, SessionInfo, CreateSessionRequest } from './types.js';

const logger = {
  info: (...args: any[]) => console.log('[SessionManager]', ...args),
  error: (...args: any[]) => console.error('[SessionManager]', ...args),
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

// --- tmux helper functions (all use execFileSync/spawnSync to prevent injection) ---

function tmuxHasSession(name: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
  return result.status === 0;
}

function tmuxNewSession(name: string, cwd: string, cols: number, rows: number): void {
  execFileSync('tmux', [
    'new-session', '-d',
    '-s', name,
    '-x', String(cols),
    '-y', String(rows),
  ], { cwd, env: { ...process.env, TERM: 'xterm-256color' } });

  // Configure the tmux session; rollback on failure
  try {
    execFileSync('tmux', ['set-option', '-t', name, 'status', 'off']);
    execFileSync('tmux', ['set-option', '-t', name, 'mouse', 'on']);
    execFileSync('tmux', ['set-option', '-t', name, 'history-limit', '50000']);
  } catch {
    tmuxKillSession(name);
    throw new Error(`Failed to configure tmux session ${name}`);
  }
}

function tmuxKillSession(name: string): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  } catch {
    // Session may already be dead
  }
}

function tmuxCapture(name: string, lines: number): string {
  try {
    const output = execFileSync('tmux', [
      'capture-pane', '-t', name, '-p', '-e',
      '-S', String(-lines),
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return output;
  } catch {
    return '';
  }
}

function tmuxSendKeys(name: string, text: string): boolean {
  try {
    execFileSync('tmux', ['send-keys', '-t', name, '-l', text]);
    return true;
  } catch {
    return false;
  }
}

// --- SessionManager ---

class SessionManager {
  private sessions = new Map<string, Session>();

  async init(): Promise<void> {
    // Check tmux is installed
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' });
    if (result.status !== 0) {
      console.error('tmux is not installed or not in PATH. Exiting.');
      process.exit(1);
    }
    console.log(`tmux version: ${result.stdout.trim()}`);

    // Ensure data directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    // Load persisted session metadata
    const metas = this.loadMetas();
    for (const meta of metas) {
      const alive = tmuxHasSession(meta.tmuxName);
      this.sessions.set(meta.id, { ...meta, alive });
    }

    const total = metas.length;
    const aliveCount = Array.from(this.sessions.values()).filter(s => s.alive).length;
    console.log(`Restored ${total} sessions (${aliveCount} alive, ${total - aliveCount} dead)`);
  }

  create(req: CreateSessionRequest): SessionInfo {
    const id = randomUUID();
    let tmuxName = `cw-${id.slice(0, 8)}`;

    // Handle unlikely collision
    if (tmuxHasSession(tmuxName)) {
      tmuxName = `cw-${id.slice(0, 16)}`;
    }

    const cols = 120;
    const rows = 30;

    const cwd = process.env.HOME || '/';
    tmuxNewSession(tmuxName, cwd, cols, rows);

    const session: Session = {
      id,
      tmuxName,
      name: req.name,
      cwd,
      createdAt: Date.now(),
      alive: true,
    };

    this.sessions.set(id, session);
    this.saveMetas();

    return this.toInfo(session);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  destroy(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    tmuxKillSession(session.tmuxName);
    this.sessions.delete(id);
    this.saveMetas();
    return true;
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => {
      s.alive = tmuxHasSession(s.tmuxName);
      return this.toInfo(s);
    });
  }

  checkAlive(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.alive = tmuxHasSession(session.tmuxName);
    return session.alive;
  }

  sendInput(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    const ok = tmuxSendKeys(session.tmuxName, text);
    if (!ok) {
      session.alive = false;
    }
    return ok;
  }

  getScreen(id: string, lines: number = 50): string | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (!tmuxHasSession(session.tmuxName)) {
      session.alive = false;
      return null;
    }
    return tmuxCapture(session.tmuxName, lines);
  }

  restart(id: string): SessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    // Kill old tmux session if it exists
    tmuxKillSession(session.tmuxName);

    // Create new tmux session with same tmuxName
    const cols = 120;
    const rows = 30;
    try {
      tmuxNewSession(session.tmuxName, session.cwd, cols, rows);
    } catch (err) {
      console.error(`Failed to restart session ${id}:`, err);
      session.alive = false;
      return null;
    }

    // Update alive status
    session.alive = true;
    this.saveMetas();

    return this.toInfo(session);
  }

  private loadMetas(): SessionMeta[] {
    if (!existsSync(SESSIONS_FILE)) return [];
    try {
      const raw = readFileSync(SESSIONS_FILE, 'utf-8');
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) {
          logger.error('Session metas file is not an array');
          return [];
        }
        return data;
      } catch (parseError: any) {
        logger.error('Failed to parse session metas JSON:', parseError.message);
        return [];
      }
    } catch (readError: any) {
      logger.error('Failed to read session metas file:', readError.message);
      return [];
    }
  }

  private saveMetas(): void {
    const metas: SessionMeta[] = Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      tmuxName: s.tmuxName,
      name: s.name,
      cwd: s.cwd,
      createdAt: s.createdAt,
    }));
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmpFile = SESSIONS_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(metas, null, 2));
    renameSync(tmpFile, SESSIONS_FILE);
  }

  /**
   * 优雅关闭：保存所有会话元数据
   */
  async flush(): Promise<void> {
    try {
      this.saveMetas();
      logger.info('Session metas saved on shutdown');
    } catch (error: any) {
      logger.error('Failed to save session metas on shutdown:', error.message);
    }
  }

  private toInfo(session: Session): SessionInfo {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      createdAt: session.createdAt,
      alive: session.alive,
    };
  }
}

export const sessionManager = new SessionManager();
