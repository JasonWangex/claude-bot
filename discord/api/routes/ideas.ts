/**
 * Ideas CRUD 路由
 *
 * GET    /api/ideas            — 列出 Ideas，支持 ?project=&status= 筛选
 * POST   /api/ideas            — 创建 Idea
 * GET    /api/ideas/:id        — Idea 详情
 * PATCH  /api/ideas/:id        — 更新 Idea（name, status）
 * DELETE /api/ideas/:id        — 删除 Idea
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb, IdeaRepository } from '../../db/index.js';
import type { Idea, IdeaStatus, IdeaType } from '../../types/repository.js';

const VALID_STATUSES: IdeaStatus[] = ['Idea', 'Processing', 'Active', 'Paused', 'Done', 'Dropped'];
const VALID_TYPES: IdeaType[] = ['manual', 'todo'];

function getRepo() {
  return new IdeaRepository(getDb());
}

/** Idea → API 响应格式 (snake_case) */
function toApiIdea(idea: Idea) {
  return {
    id: idea.id,
    name: idea.name,
    status: idea.status,
    type: idea.type,
    project: idea.project,
    date: idea.date,
    body: idea.body ?? null,
    created_at: idea.createdAt,
    updated_at: idea.updatedAt,
  };
}

// GET /api/ideas
export const listIdeas: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const project = url.searchParams.get('project');
  const status = url.searchParams.get('status') as IdeaStatus | null;

  try {
    const repo = getRepo();
    let ideas: Idea[];

    if (project && status) {
      ideas = await repo.findByProjectAndStatus(project, status);
    } else if (project) {
      ideas = await repo.findByProject(project);
    } else if (status) {
      ideas = await repo.findByStatus(status);
    } else {
      ideas = await repo.getAll();
    }

    sendJson(res, 200, { ok: true, data: ideas.map(toApiIdea) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list ideas: ${error.message}` });
  }
};

// GET /api/ideas/:id
export const getIdea: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const idea = await repo.get(params.id);
    if (!idea) {
      sendJson(res, 404, { ok: false, error: 'Idea not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: toApiIdea(idea) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get idea: ${error.message}` });
  }
};

interface CreateIdeaRequest {
  name: string;
  project: string;
  status?: IdeaStatus;
  type?: IdeaType;
  date?: string;
  body?: string;
}

// POST /api/ideas
export const createIdea: RouteHandler = async (req, res) => {
  const body = await readJsonBody<CreateIdeaRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  if (!body.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }
  if (!body.project || typeof body.project !== 'string') {
    sendJson(res, 400, { ok: false, error: '"project" field is required' });
    return;
  }

  const status = body.status || 'Idea';
  if (!VALID_STATUSES.includes(status)) {
    sendJson(res, 400, { ok: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  const type = body.type || 'manual';
  if (!VALID_TYPES.includes(type)) {
    sendJson(res, 400, { ok: false, error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
    return;
  }

  const date = body.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(res, 400, { ok: false, error: '"date" must be in yyyy-MM-dd format' });
    return;
  }

  try {
    const repo = getRepo();
    const now = Date.now();
    const id = `idea-${now}-${Math.random().toString(36).slice(2, 8)}`;

    const idea: Idea = {
      id,
      name: body.name.trim(),
      status,
      type,
      project: body.project.trim(),
      date,
      body: body.body ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await repo.save(idea);
    sendJson(res, 201, { ok: true, data: toApiIdea(idea) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create idea: ${error.message}` });
  }
};

interface UpdateIdeaRequest {
  name?: string;
  status?: IdeaStatus;
  type?: IdeaType;
  project?: string;
  body?: string | null;
}

// PATCH /api/ideas/:id
export const updateIdea: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<UpdateIdeaRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    sendJson(res, 400, { ok: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  if (body.type !== undefined && !VALID_TYPES.includes(body.type)) {
    sendJson(res, 400, { ok: false, error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
    return;
  }

  try {
    const repo = getRepo();
    const idea = await repo.get(params.id);
    if (!idea) {
      sendJson(res, 404, { ok: false, error: 'Idea not found' });
      return;
    }

    if (body.name !== undefined) idea.name = body.name.trim();
    if (body.status !== undefined) idea.status = body.status;
    if (body.type !== undefined) idea.type = body.type;
    if (body.project !== undefined) idea.project = body.project.trim();
    if ('body' in body) idea.body = body.body ?? null;
    idea.updatedAt = Date.now();

    await repo.save(idea);
    sendJson(res, 200, { ok: true, data: toApiIdea(idea) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update idea: ${error.message}` });
  }
};

// DELETE /api/ideas/:id
export const deleteIdea: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const deleted = await repo.delete(params.id);
    if (!deleted) {
      sendJson(res, 404, { ok: false, error: 'Idea not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to delete idea: ${error.message}` });
  }
};
