/**
<<<<<<< HEAD
 * Ideas CRUD 路由
 *
 * GET    /api/ideas              — 列出所有 Ideas（支持 ?project=&status= 筛选）
 * POST   /api/ideas              — 创建 Idea
 * GET    /api/ideas/:id          — Idea 详情
 * PATCH  /api/ideas/:id          — 更新 Idea
 */

import { randomUUID } from 'node:crypto';
import type { RouteHandler, CreateIdeaRequest, UpdateIdeaRequest } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { IdeaRepository } from '../../db/idea-repo.js';
import type { IdeaStatus } from '../../types/repository.js';

const VALID_STATUSES: IdeaStatus[] = ['Idea', 'Processing', 'Active', 'Paused', 'Done', 'Dropped'];

function isValidStatus(s: string): s is IdeaStatus {
  return (VALID_STATUSES as string[]).includes(s);
}

function getRepo(): IdeaRepository {
  return new IdeaRepository(getDb());
}

=======
 * Idea CRUD 路由
 *
 * GET    /api/ideas          — 列出 Idea，支持 ?project=&status= 筛选
 * POST   /api/ideas          — 创建 Idea
 * GET    /api/ideas/:id      — Idea 详情
 * PATCH  /api/ideas/:id      — 更新 Idea（支持部分更新）
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb, IdeaRepository } from '../../db/index.js';
import type { Idea, IdeaStatus } from '../../types/repository.js';

function getRepo() {
  return new IdeaRepository(getDb());
}

/** Idea → API 响应格式 (snake_case) */
function toApiIdea(idea: Idea) {
  return {
    id: idea.id,
    name: idea.name,
    status: idea.status,
    project: idea.project,
    date: idea.date,
    created_at: idea.createdAt,
    updated_at: idea.updatedAt,
  };
}

const VALID_STATUSES: IdeaStatus[] = ['Idea', 'Processing', 'Active', 'Paused', 'Done', 'Dropped'];

>>>>>>> feat/t14-devlog-merge-skill-http-api
// GET /api/ideas
export const listIdeas: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const project = url.searchParams.get('project');
<<<<<<< HEAD
  const status = url.searchParams.get('status');

  try {
    const repo = getRepo();
    let ideas;

    if (project && status) {
      if (!isValidStatus(status)) {
        sendJson(res, 400, { ok: false, error: `Invalid status: ${status}` });
        return;
      }
      ideas = await repo.findByProjectAndStatus(project, status);
    } else if (project) {
      ideas = await repo.findByProject(project);
    } else if (status) {
      if (!isValidStatus(status)) {
        sendJson(res, 400, { ok: false, error: `Invalid status: ${status}` });
        return;
      }
      ideas = await repo.findByStatus(status);
=======
  const status = url.searchParams.get('status') as IdeaStatus | null;

  try {
    const repo = getRepo();
    let ideas: Idea[];

    if (project && status) {
      ideas = await repo.findByProjectAndStatus(project, status);
    } else if (status) {
      ideas = await repo.findByStatus(status);
    } else if (project) {
      ideas = await repo.findByProject(project);
>>>>>>> feat/t14-devlog-merge-skill-http-api
    } else {
      ideas = await repo.getAll();
    }

<<<<<<< HEAD
    sendJson(res, 200, { ok: true, data: ideas });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// POST /api/ideas
export const createIdea: RouteHandler = async (req, res) => {
  const body = await readJsonBody<CreateIdeaRequest>(req);
  if (!body?.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }
  if (!body.project || typeof body.project !== 'string') {
    sendJson(res, 400, { ok: false, error: '"project" field is required' });
    return;
  }

  const name = body.name.trim();
  if (!name) {
    sendJson(res, 400, { ok: false, error: '"name" must not be empty' });
    return;
  }

  const project = body.project.trim();
  if (!project) {
    sendJson(res, 400, { ok: false, error: '"project" must not be empty' });
    return;
  }

  const status: IdeaStatus = body.status ? (body.status as IdeaStatus) : 'Idea';
  if (!isValidStatus(status)) {
    sendJson(res, 400, { ok: false, error: `Invalid status: ${body.status}` });
    return;
  }

  const now = Date.now();
  const idea = {
    id: randomUUID(),
    name,
    status,
    project,
    date: new Date(now).toISOString().slice(0, 10),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const repo = getRepo();
    await repo.save(idea);
    sendJson(res, 201, { ok: true, data: idea });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
=======
    sendJson(res, 200, { ok: true, data: ideas.map(toApiIdea) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list ideas: ${error.message}` });
>>>>>>> feat/t14-devlog-merge-skill-http-api
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
<<<<<<< HEAD
    sendJson(res, 200, { ok: true, data: idea });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

=======
    sendJson(res, 200, { ok: true, data: toApiIdea(idea) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get idea: ${error.message}` });
  }
};

interface CreateIdeaRequest {
  name: string;
  project: string;
  status?: IdeaStatus;
  date?: string;
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
    sendJson(res, 400, { ok: false, error: `"status" must be one of: ${VALID_STATUSES.join(', ')}` });
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
      project: body.project.trim(),
      date,
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
  project?: string;
}

>>>>>>> feat/t14-devlog-merge-skill-http-api
// PATCH /api/ideas/:id
export const updateIdea: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<UpdateIdeaRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

<<<<<<< HEAD
=======
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    sendJson(res, 400, { ok: false, error: `"status" must be one of: ${VALID_STATUSES.join(', ')}` });
    return;
  }

>>>>>>> feat/t14-devlog-merge-skill-http-api
  try {
    const repo = getRepo();
    const existing = await repo.get(params.id);
    if (!existing) {
      sendJson(res, 404, { ok: false, error: 'Idea not found' });
      return;
    }

<<<<<<< HEAD
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) {
        sendJson(res, 400, { ok: false, error: '"name" must not be empty' });
        return;
      }
      existing.name = name;
    }

    if (body.status !== undefined) {
      if (!isValidStatus(body.status)) {
        sendJson(res, 400, { ok: false, error: `Invalid status: ${body.status}` });
        return;
      }
      existing.status = body.status;
    }

    if (body.project !== undefined) {
      const project = body.project.trim();
      if (!project) {
        sendJson(res, 400, { ok: false, error: '"project" must not be empty' });
        return;
      }
      existing.project = project;
    }

    existing.updatedAt = Date.now();
    await repo.save(existing);
    sendJson(res, 200, { ok: true, data: existing });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
=======
    const updated: Idea = {
      ...existing,
      name: body.name?.trim() || existing.name,
      status: body.status || existing.status,
      project: body.project?.trim() || existing.project,
      updatedAt: Date.now(),
    };

    await repo.save(updated);
    sendJson(res, 200, { ok: true, data: toApiIdea(updated) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update idea: ${error.message}` });
>>>>>>> feat/t14-devlog-merge-skill-http-api
  }
};
