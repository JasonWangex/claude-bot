/**
 * 结构化 RESTful API 服务器
 *
 * 每个功能独立端点，返回结构化 JSON。
 * 不走 Telegraf 管道注入，直接调用服务层。
 * 唯一例外: POST /api/topics/:id/message 会输出到 Telegram 会话。
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Server } from 'http';
import type { Route, ApiDeps } from './types.js';
import { sendJson } from './middleware.js';
import { logger } from '../utils/logger.js';

// Route handlers
import { getHealth } from './routes/health.js';
import { getStatus, getUsage } from './routes/status.js';
import { listTopics, createTopic, getTopic, updateTopic, deleteTopic, archiveTopic, forkTopic } from './routes/topics.js';
import { sendMessage } from './routes/messages.js';
import { clearSession, compactSession, rewindSession, stopSession } from './routes/session-ops.js';
import { getModels, setDefaultModel } from './routes/models.js';

function defineRoutes(): Route[] {
  const r = (method: string, path: string, handler: Route['handler']): Route => {
    // 将 /api/topics/:topicId/message 转成正则 + 参数名
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
    r('GET',  '/api/usage', getUsage),
    r('GET',  '/api/usage/:date', getUsage),

    // 模型
    r('GET',  '/api/models', getModels),
    r('PUT',  '/api/models/default', setDefaultModel),

    // Topic CRUD
    r('GET',    '/api/topics', listTopics),
    r('POST',   '/api/topics', createTopic),
    r('GET',    '/api/topics/:topicId', getTopic),
    r('PATCH',  '/api/topics/:topicId', updateTopic),
    r('DELETE', '/api/topics/:topicId', deleteTopic),
    r('POST',   '/api/topics/:topicId/archive', archiveTopic),
    r('POST',   '/api/topics/:topicId/fork', forkTopic),

    // Topic 内操作
    r('POST', '/api/topics/:topicId/message', sendMessage),
    r('POST', '/api/topics/:topicId/clear', clearSession),
    r('POST', '/api/topics/:topicId/compact', compactSession),
    r('POST', '/api/topics/:topicId/rewind', rewindSession),
    r('POST', '/api/topics/:topicId/stop', stopSession),
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

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      // 提取路径参数
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
