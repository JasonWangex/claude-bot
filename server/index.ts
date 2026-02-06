import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { setupSecurity } from './security.js';
import { initAuth, verifyPassword, signToken, requireAuth, verifyToken } from './auth.js';
import { sessionManager } from './session-manager.js';
import type { WebSocketClient, CreateSessionRequest, SendInputRequest } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.PORT || '9000', 10);

// Security middleware
setupSecurity(app);
app.use(express.json({ limit: '10kb' }));

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  const distPath = join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
}

// --- REST API ---

app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required' });
    return;
  }
  const valid = await verifyPassword(password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = signToken();
  res.json({ token });
});

app.get('/api/sessions', requireAuth, (_req, res) => {
  res.json(sessionManager.list());
});

app.post('/api/sessions', requireAuth, (req, res) => {
  const { name } = req.body as CreateSessionRequest;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const session = sessionManager.create({ name });
    res.status(201).json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create session' });
  }
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const id = req.params.id as string;
  const destroyed = sessionManager.destroy(id);
  if (!destroyed) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ ok: true });
});

// --- IM API endpoints ---

app.post('/api/sessions/:id/input', requireAuth, (req, res) => {
  const id = req.params.id as string;
  const { text } = req.body as SendInputRequest;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const session = sessionManager.get(id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const ok = sessionManager.sendInput(id, text);
  if (!ok) {
    res.status(410).json({ error: 'Session is not alive' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/sessions/:id/screen', requireAuth, (req, res) => {
  const id = req.params.id as string;
  const lines = Math.min(Math.max(parseInt(req.query.lines as string) || 50, 1), 5000);
  const session = sessionManager.get(id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const content = sessionManager.getScreen(id, lines);
  if (content === null) {
    res.status(410).json({ error: 'Session is not alive' });
    return;
  }
  res.json({ content });
});

// SPA fallback in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
  });
}

// --- WebSocket ---

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

wss.on('connection', (ws: WebSocketClient, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    ws.close(4002, 'Session ID required');
    return;
  }

  ws.isAlive = true;
  ws.sessionId = sessionId;

  let authenticated = false;
  let attachPty: pty.IPty | null = null;

  // Auth timeout — must authenticate within 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, 'Auth timeout');
    }
  }, 5000);

  ws.on('message', (data: Buffer | string) => {
    // Check raw size before toString() to prevent memory exhaustion
    const rawLen = typeof data === 'string' ? data.length : data.byteLength;
    if (rawLen > 1024 * 1024) return;

    const msg = data.toString();

    // First message must be auth
    if (!authenticated) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'auth' && parsed.token && verifyToken(parsed.token)) {
          authenticated = true;
          clearTimeout(authTimeout);

          const session = sessionManager.get(sessionId);
          if (!session) {
            ws.close(4003, 'Session not found');
            return;
          }

          // Check if tmux session is alive
          if (!sessionManager.checkAlive(sessionId)) {
            ws.close(4005, 'Session is dead');
            return;
          }

          // Spawn a temporary tmux attach PTY with client-provided size
          const cols = (typeof parsed.cols === 'number' && parsed.cols > 0 && parsed.cols < 500) ? parsed.cols : 120;
          const rows = (typeof parsed.rows === 'number' && parsed.rows > 0 && parsed.rows < 300) ? parsed.rows : 30;
          try {
            attachPty = pty.spawn('tmux', ['attach-session', '-t', session.tmuxName], {
              name: 'xterm-256color',
              cols,
              rows,
              env: {
                ...process.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
              } as Record<string, string>,
            });

            // attach PTY → WebSocket
            attachPty.onData((ptyData: string) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(ptyData);
              }
            });

            // attach PTY exit → check if tmux session truly died
            attachPty.onExit(() => {
              if (ws.readyState === ws.OPEN) {
                const stillAlive = sessionManager.checkAlive(sessionId);
                if (!stillAlive) {
                  ws.send(`\r\n\x1b[31m[Session ended]\x1b[0m\r\n`);
                  ws.close(4004, 'Session ended');
                } else {
                  // attach detached for some reason but session still alive
                  ws.close(4006, 'Attach detached');
                }
              }
              attachPty = null;
            });
          } catch (err: any) {
            ws.close(4003, 'Failed to attach to session');
            return;
          }
        } else {
          ws.close(4001, 'Unauthorized');
        }
      } catch {
        ws.close(4001, 'Invalid auth message');
      }
      return;
    }

    // Handle resize messages
    if (msg.startsWith('\x01resize:')) {
      try {
        const resizeData = JSON.parse(msg.slice(8));
        const { cols, rows } = resizeData;
        if (typeof cols === 'number' && typeof rows === 'number'
          && cols > 0 && cols < 500 && rows > 0 && rows < 300) {
          attachPty?.resize(cols, rows);
        }
      } catch {
        // ignore invalid resize
      }
      return;
    }

    // Forward input to attach PTY
    attachPty?.write(msg);
  });

  // Heartbeat pong
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    // Kill the temporary attach PTY (tmux session is not affected)
    try { attachPty?.kill(); } catch { /* already dead */ }
    attachPty = null;
  });
});

// Heartbeat interval (30s)
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const client = ws as WebSocketClient;
    if (!client.isAlive) {
      client.terminate();
      return;
    }
    client.isAlive = false;
    client.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

// --- Start ---

async function main() {
  await initAuth();
  await sessionManager.init();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Web Terminal running on http://0.0.0.0:${PORT}`);
  });
}

main().catch(console.error);
