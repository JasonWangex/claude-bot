/**
 * 结构化 RESTful API 服务器（Discord 版）
 *
 * 每个功能独立端点，返回结构化 JSON。
 * 不走 Discord.js 管道，直接调用服务层。
 * 唯一例外: POST /api/tasks/:id/message 会输出到 Discord 会话。
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Server } from 'http';
import type { Route, ApiDeps } from './types.js';
import { sendJson, requireToken } from './middleware.js';
import { logger } from '../utils/logger.js';

// Route handlers
import { getHealth } from './routes/health.js';
import { getStatus } from './routes/status.js';
import { listTasks, createTask, getTask, updateTask, deleteTask, archiveTask, forkTask } from './routes/tasks.js';
import { sendMessage } from './routes/messages.js';
import { clearSession, compactSession, rewindSession, stopSession } from './routes/session-ops.js';
import { getModels, setDefaultModel } from './routes/models.js';
import { startDrive, getDriveStatus, pauseDrive, resumeDrive, skipTask, markTaskDone, retryTask } from './routes/goals.js';
import { listGoals, getGoal, createGoal, updateGoal } from './routes/goal-crud.js';
import { qdev } from './routes/qdev.js';
import { listDevLogs, getDevLog, createDevLog } from './routes/devlogs.js';

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

    // 模型
    r('GET',  '/api/models', getModels),
    r('PUT',  '/api/models/default', setDefaultModel),

    // Task CRUD
    r('GET',    '/api/tasks', listTasks),
    r('POST',   '/api/tasks', createTask),
    r('GET',    '/api/tasks/:threadId', getTask),
    r('PATCH',  '/api/tasks/:threadId', updateTask),
    r('DELETE', '/api/tasks/:threadId', deleteTask),
    r('POST',   '/api/tasks/:threadId/archive', archiveTask),
    r('POST',   '/api/tasks/:threadId/fork', forkTask),
    r('POST',   '/api/tasks/:threadId/qdev', qdev),

    // Task 内操作
    r('POST', '/api/tasks/:threadId/message', sendMessage),
    r('POST', '/api/tasks/:threadId/clear', clearSession),
    r('POST', '/api/tasks/:threadId/compact', compactSession),
    r('POST', '/api/tasks/:threadId/rewind', rewindSession),
    r('POST', '/api/tasks/:threadId/stop', stopSession),

    // DevLog CRUD
    r('GET',  '/api/devlogs', listDevLogs),
    r('POST', '/api/devlogs', createDevLog),
    r('GET',  '/api/devlogs/:id', getDevLog),

    // Goal CRUD
    r('GET',    '/api/goals', listGoals),
    r('POST',   '/api/goals', createGoal),
    r('GET',    '/api/goals/:goalId', getGoal),
    r('PATCH',  '/api/goals/:goalId', updateGoal),

    // Goal Drive
    r('POST', '/api/goals/:goalId/drive', startDrive),
    r('GET',  '/api/goals/:goalId/status', getDriveStatus),
    r('POST', '/api/goals/:goalId/pause', pauseDrive),
    r('POST', '/api/goals/:goalId/resume', resumeDrive),
    r('POST', '/api/goals/:goalId/tasks/:taskId/skip', skipTask),
    r('POST', '/api/goals/:goalId/tasks/:taskId/done', markTaskDone),
    r('POST', '/api/goals/:goalId/tasks/:taskId/retry', retryTask),
  ];
}

export class ApiServer {
  private server: Server | null = null;
  private routes: Route[];
  private deps: ApiDeps;
  private port: number;

  constructor(deps: ApiDeps) {
    this.deps = deps;
    this.port = deps.config.apiPort;
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
      this.server!.listen(this.port, '127.0.0.1', () => {
        logger.info(`API server listening on http://127.0.0.1:${this.port}`);
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // health 端点无需认证，其他端点需要 Bearer token
    if (pathname !== '/api/health') {
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
