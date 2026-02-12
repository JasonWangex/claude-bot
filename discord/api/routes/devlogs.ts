/**
 * DevLog CRUD 路由
 *
 * GET  /api/devlogs          — 列出 DevLog，支持 ?project=&date=&start=&end= 筛选
 * POST /api/devlogs          — 创建 DevLog
 * GET  /api/devlogs/:id      — DevLog 详情
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb, DevLogRepository } from '../../db/index.js';
import type { DevLog } from '../../types/repository.js';

function getRepo() {
  return new DevLogRepository(getDb());
}

/** DevLog → API 响应格式 (snake_case) */
function toApiDevLog(log: DevLog) {
  return {
    id: log.id,
    name: log.name,
    date: log.date,
    project: log.project,
    branch: log.branch,
    summary: log.summary,
    commits: log.commits,
    lines_changed: log.linesChanged,
    goal: log.goal ?? null,
    content: log.content ?? null,
    created_at: log.createdAt,
  };
}

// GET /api/devlogs
export const listDevLogs: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const project = url.searchParams.get('project');
  const date = url.searchParams.get('date');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  try {
    const repo = getRepo();
    let logs: DevLog[];

    if (date) {
      // 单日查询：date=2025-01-15
      logs = await repo.findByDateRange(date, date);
      if (project) logs = logs.filter(l => l.project === project);
    } else if (start || end) {
      // 范围查询：start=2025-01-01&end=2025-01-31
      const s = start || '0000-01-01';
      const e = end || '9999-12-31';
      logs = await repo.findByDateRange(s, e);
      if (project) logs = logs.filter(l => l.project === project);
    } else if (project) {
      logs = await repo.findByProject(project);
    } else {
      logs = await repo.getAll();
    }

    sendJson(res, 200, { ok: true, data: logs.map(toApiDevLog) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list devlogs: ${error.message}` });
  }
};

// GET /api/devlogs/:id
export const getDevLog: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const log = await repo.get(params.id);
    if (!log) {
      sendJson(res, 404, { ok: false, error: 'DevLog not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: toApiDevLog(log) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get devlog: ${error.message}` });
  }
};

interface CreateDevLogRequest {
  name: string;
  date: string;
  project: string;
  branch?: string;
  summary?: string;
  commits?: number;
  lines_changed?: string;
  goal?: string;
  content?: string;
}

// POST /api/devlogs
export const createDevLog: RouteHandler = async (req, res) => {
  const body = await readJsonBody<CreateDevLogRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  // 必填字段校验
  if (!body.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }
  if (!body.date || typeof body.date !== 'string') {
    sendJson(res, 400, { ok: false, error: '"date" field is required (yyyy-MM-dd)' });
    return;
  }
  if (!body.project || typeof body.project !== 'string') {
    sendJson(res, 400, { ok: false, error: '"project" field is required' });
    return;
  }

  // date 格式校验
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    sendJson(res, 400, { ok: false, error: '"date" must be in yyyy-MM-dd format' });
    return;
  }

  try {
    const repo = getRepo();
    const id = `devlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const log: DevLog = {
      id,
      name: body.name.trim(),
      date: body.date,
      project: body.project.trim(),
      branch: body.branch?.trim() || '',
      summary: body.summary?.trim() || '',
      commits: body.commits ?? 0,
      linesChanged: body.lines_changed || '',
      goal: body.goal?.trim() || undefined,
      content: body.content || undefined,
      createdAt: Date.now(),
    };

    await repo.save(log);
    sendJson(res, 201, { ok: true, data: toApiDevLog(log) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create devlog: ${error.message}` });
  }
};
