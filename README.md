# Claude Web Terminal

Browser-based terminal with tmux-backed persistent sessions. Sessions survive server restarts — running processes (including Claude CLI) stay alive across deploys and reconnections.

## Architecture

```
tmux server (daemon)
  ├── cw-abc12345 → bash → claude   ← persistent
  └── cw-def67890 → bash            ← persistent

Node.js server
  ├── WS client → temp PTY (tmux attach)  ← per-connection, disposable
  ├── REST API (IM):
  │     POST /sessions/:id/input   → tmux send-keys
  │     GET  /sessions/:id/screen  → tmux capture-pane
  └── data/sessions.json           ← metadata persistence
```

## Prerequisites

- Node.js >= 18
- tmux >= 3.0

## Setup

```bash
npm install

# Create .env
cat > .env << 'EOF'
PASSWORD=your-password
JWT_SECRET=your-random-secret
PORT=9000
EOF
```

## Run

```bash
# Development (Vite HMR + tsx watch)
npm run dev

# Production
npm run build && npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PASSWORD` | Yes | - | Login password |
| `JWT_SECRET` | Yes (prod) | fallback in dev | JWT signing secret |
| `PORT` | No | `9000` | Server port |
| `CORS_ORIGINS` | No | localhost | Comma-separated allowed origins |

## API

### Auth

```
POST /api/login              { password } → { token }
```

### Sessions

```
GET    /api/sessions         → SessionInfo[]
POST   /api/sessions         { name } → SessionInfo
DELETE /api/sessions/:id     → { ok }
```

### IM Integration

```bash
# Send input to a session
curl -X POST http://localhost:9000/api/sessions/:id/input \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"echo hello\n"}'

# Capture screen content
curl http://localhost:9000/api/sessions/:id/screen?lines=50 \
  -H "Authorization: Bearer $TOKEN"
```

### WebSocket

```
ws://host/ws?sessionId=<id>
```

First message must be auth: `{"type":"auth","token":"...","cols":80,"rows":24}`

## Tech Stack

- **Frontend**: React 19 + Vite + TypeScript + xterm.js
- **Backend**: Express 5 + WebSocket + node-pty + tmux
- **Auth**: JWT + bcrypt
- **Security**: helmet, express-rate-limit, CORS, CSP
