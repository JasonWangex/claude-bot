/**
 * 结构化 RESTful API 服务器（Discord 版）
 *
 * 每个功能独立端点，返回结构化 JSON。
 * 不走 Discord.js 管道，直接调用服务层。
 * 唯一例外: POST /api/channels/:id/message 会输出到 Discord 会话。
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Server } from 'http';
import type { Route, ApiDeps } from './types.js';
import { sendJson, requireToken } from './middleware.js';
import { logger } from '../utils/logger.js';

// Route handlers
import { getHealth } from './routes/health.js';
import { getStatus } from './routes/status.js';
import { listChannels, createChannel, getChannel, updateChannel, deleteChannel, archiveChannel, forkChannel } from './routes/channels.js';
import { sendMessage } from './routes/messages.js';
import { clearSession, compactSession, rewindSession, stopSession } from './routes/session-ops.js';
import { getModels, setDefaultModel } from './routes/models.js';
import { startDrive, getDriveStatus, pauseDrive, resumeDrive, skipTask, markTaskDone, retryTask, resetAndStartTask, pauseTask, nudgeTask, rollback, confirmRollback, cancelRollback } from './routes/goals.js';
import { listGoals, createGoal, getGoal, updateGoal, getGoalTimeline } from './routes/goal-crud.js';
import { setGoalTasks } from './routes/goal-tasks.js';
import { createGoalEvent } from './routes/goal-events.js';
import { listGoalTodos, createGoalTodo, updateGoalTodo, deleteGoalTodo } from './routes/goal-todos.js';
import { qdev } from './routes/qdev.js';
import { codeAudit } from './routes/code-audit.js';
import { listDevLogs, getDevLog, createDevLog } from './routes/devlogs.js';
import { listIdeas, createIdea, getIdea, updateIdea, deleteIdea } from './routes/ideas.js';
import { listKnowledgeBase, createKnowledgeBase, getKnowledgeBaseEntry, updateKnowledgeBase, deleteKnowledgeBase } from './routes/knowledge-base.js';
import { syncSessions, syncUsage, syncDiscord } from './routes/sync.js';
import { getCommands } from './routes/commands.js';
import { getSessionConversation } from './routes/sessions.js';
import { listSessions, getSessionMeta } from './routes/session-list.js';
import { getUsageDaily } from './routes/usage-daily.js';
import { getUsageByModel } from './routes/usage-by-model.js';
import { listChannelSessions } from './routes/channel-sessions.js';
import { listPrompts, getPrompt, updatePrompt, refreshPrompts } from './routes/prompts.js';
import { getRunningTasks, getActiveProcesses, killZombieTasks } from './routes/debug.js';
import { handleSessionEvent } from './routes/hooks.js';
import { createTaskEvent, listTaskEvents } from './routes/task-events.js';
import { listSessionChanges, getSessionChanges } from './routes/session-changes.js';
import { listProjects, getProject, syncProjects } from './routes/projects.js';

function defineRoutes(): Route[] {
  const r = (method: string, path: string, handler: Route['handler']): Route => {
    const paramNames: string[] = [];
    const regexStr = path.replace(/:(\w+)/g, (_m, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    return { method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler };
  };

  return [
    // 系统
    r('GET',  '/api/health', getHealth),
    r('GET',  '/api/status', getStatus),
    r('GET',  '/api/projects', listProjects),
    r('POST', '/api/projects/sync', syncProjects),
    r('GET',  '/api/projects/:name', getProject),

    // 命令
    r('GET',  '/api/commands', getCommands),

    // 模型
    r('GET',  '/api/models', getModels),
    r('PUT',  '/api/models/default', setDefaultModel),

    // Channel CRUD
    r('GET',    '/api/channels', listChannels),
    r('POST',   '/api/channels', createChannel),
    r('GET',    '/api/channels/:channelId', getChannel),
    r('PATCH',  '/api/channels/:channelId', updateChannel),
    r('DELETE', '/api/channels/:channelId', deleteChannel),
    r('POST',   '/api/channels/:channelId/archive', archiveChannel),
    r('POST',   '/api/channels/:channelId/fork', forkChannel),
    r('POST',   '/api/channels/:channelId/qdev', qdev),
    r('POST',   '/api/channels/:channelId/code-audit', codeAudit),

    // Channel sessions
    r('GET',  '/api/channels/:channelId/sessions', listChannelSessions),

    // Channel 内操作
    r('POST', '/api/channels/:channelId/message', sendMessage),
    r('POST', '/api/channels/:channelId/clear', clearSession),
    r('POST', '/api/channels/:channelId/compact', compactSession),
    r('POST', '/api/channels/:channelId/rewind', rewindSession),
    r('POST', '/api/channels/:channelId/stop', stopSession),

    // DevLog CRUD
    r('GET',  '/api/devlogs', listDevLogs),
    r('POST', '/api/devlogs', createDevLog),
    r('GET',  '/api/devlogs/:id', getDevLog),

    // Goal CRUD
    r('GET',    '/api/goals', listGoals),
    r('POST',   '/api/goals', createGoal),
    r('GET',    '/api/goals/:goalId', getGoal),
    r('PATCH',  '/api/goals/:goalId', updateGoal),
    r('GET',    '/api/goals/:goalId/timeline', getGoalTimeline),

    // Goal Tasks & Events (pre-drive)
    r('POST', '/api/goals/:goalId/tasks', setGoalTasks),
    r('POST', '/api/goals/:goalId/events', createGoalEvent),

    // Goal Drive
    r('POST', '/api/goals/:goalId/drive', startDrive),
    r('GET',  '/api/goals/:goalId/status', getDriveStatus),
    r('POST', '/api/goals/:goalId/pause', pauseDrive),
    r('POST', '/api/goals/:goalId/resume', resumeDrive),
    r('POST', '/api/goals/:goalId/tasks/:taskId/skip', skipTask),
    r('POST', '/api/goals/:goalId/tasks/:taskId/done', markTaskDone),
    r('POST', '/api/goals/:goalId/tasks/:taskId/retry', retryTask),
    r('POST', '/api/goals/:goalId/tasks/:taskId/reset', resetAndStartTask),
    r('POST', '/api/goals/:goalId/tasks/:taskId/pause', pauseTask),
    r('POST', '/api/goals/:goalId/tasks/:taskId/nudge', nudgeTask),
    r('POST', '/api/goals/:goalId/rollback', rollback),
    r('POST', '/api/goals/:goalId/confirm-rollback', confirmRollback),
    r('POST', '/api/goals/:goalId/cancel-rollback', cancelRollback),

    // Goal Todos
    r('GET',    '/api/goals/:goalId/todos', listGoalTodos),
    r('POST',   '/api/goals/:goalId/todos', createGoalTodo),
    r('PATCH',  '/api/goals/:goalId/todos/:todoId', updateGoalTodo),
    r('DELETE', '/api/goals/:goalId/todos/:todoId', deleteGoalTodo),

    // Ideas CRUD
    r('GET',    '/api/ideas', listIdeas),
    r('POST',   '/api/ideas', createIdea),
    r('GET',    '/api/ideas/:id', getIdea),
    r('PATCH',  '/api/ideas/:id', updateIdea),
    r('DELETE', '/api/ideas/:id', deleteIdea),

    // Knowledge Base CRUD
    r('GET',    '/api/kb', listKnowledgeBase),
    r('POST',   '/api/kb', createKnowledgeBase),
    r('GET',    '/api/kb/:id', getKnowledgeBaseEntry),
    r('PATCH',  '/api/kb/:id', updateKnowledgeBase),
    r('DELETE', '/api/kb/:id', deleteKnowledgeBase),

    // Sync
    r('POST', '/api/sync/sessions', syncSessions),
    r('POST', '/api/sync/usage', syncUsage),
    r('POST', '/api/sync/discord', syncDiscord),

    // Sessions
    r('GET', '/api/sessions', listSessions),
    r('GET', '/api/sessions/usage/daily', getUsageDaily),
    r('GET', '/api/sessions/usage/by-model', getUsageByModel),
    r('GET', '/api/sessions/:id/meta', getSessionMeta),
    r('GET', '/api/sessions/:id/conversation', getSessionConversation),

    // Prompt Config
    r('GET',    '/api/prompts',         listPrompts),
    r('POST',   '/api/prompts/refresh', refreshPrompts),
    r('GET',    '/api/prompts/:key',    getPrompt),
    r('PATCH',  '/api/prompts/:key',    updatePrompt),

    // Debug endpoints
    r('GET',  '/api/debug/running-tasks',      getRunningTasks),
    r('GET',  '/api/debug/active-processes',   getActiveProcesses),
    r('POST', '/api/debug/kill-zombie-tasks',  killZombieTasks),

    // Task Events（AI → Orchestrator 事件通信）
    r('GET',  '/api/events', listTaskEvents),
    r('POST', '/api/tasks/:taskId/events', createTaskEvent),

    // Session Changes（文件变更记录）
    r('GET', '/api/channels/:channelId/changes', listSessionChanges),
    r('GET', '/api/changes/:id', getSessionChanges),

    // Internal hooks (localhost only, no auth required)
    r('POST', '/api/internal/hooks/session-event', handleSessionEvent),
  ];
}

export class ApiServer {
  private server: Server | null = null;
  private routes: Route[];
  private deps: ApiDeps;
  private port: number;
  private listenHost: string;

  constructor(deps: ApiDeps) {
    this.deps = deps;
    this.port = deps.config.apiPort;
    this.listenHost = deps.config.apiListen || '127.0.0.1';
    this.routes = defineRoutes();
  }

  async start(): Promise<void> {
    if (this.port <= 0) {
      logger.info('API server disabled (API_PORT=0)');
      return;
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((e) => {
        logger.error('API request error:', e);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.listenHost, () => {
        logger.info(`API server listening on http://${this.listenHost}:${this.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.info('API server stopped');
        resolve();
      });
    });
  }

  /**
   * 请求来源分类：local（免鉴权）、tailscale（需 token）、denied（拒绝）
   */
  private classifyRequest(req: IncomingMessage): 'local' | 'tailscale' | 'denied' {
    const addr = req.socket.remoteAddress || '';
    // 去掉 IPv4-mapped IPv6 前缀 (::ffff:)
    const ip = addr.startsWith('::ffff:') ? addr.slice(7) : addr;

    if (ip === '127.0.0.1' || ip === '::1') return 'local';
    if (this.isTailscaleIp(ip)) return 'tailscale';
    return 'denied';
  }

  /**
   * 判断 IP 是否在 Tailscale CGNAT 范围 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
   */
  private isTailscaleIp(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    return first === 100 && second >= 64 && second <= 127;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // CORS: allow web dashboard (restrict to known origins)
    const allowedOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
    const requestOrigin = req.headers.origin;
    if (allowedOrigin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (requestOrigin && allowedOrigin.split(',').includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 来源分类：localhost 免鉴权，Tailscale 需 token，其他拒绝
    const source = this.classifyRequest(req);
    if (source === 'denied') {
      sendJson(res, 403, { ok: false, error: 'Access denied' });
      return;
    }
    if (pathname !== '/api/health' && source === 'tailscale') {
      if (!requireToken(req, res, this.deps.config.accessToken)) return;
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
      }

      await route.handler(req, res, params, this.deps);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: `Unknown endpoint: ${method} ${pathname}`,
      hint: 'Use GET /api/health to check available endpoints',
    });
  }
}
