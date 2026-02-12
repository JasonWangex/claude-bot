/**
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

// GET /api/ideas
export const listIdeas: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const project = url.searchParams.get('project');
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
    } else {
      ideas = await repo.getAll();
    }

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
    sendJson(res, 200, { ok: true, data: idea });
  } catch (err: any) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// PATCH /api/ideas/:id
export const updateIdea: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<UpdateIdeaRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  try {
    const repo = getRepo();
    const existing = await repo.get(params.id);
    if (!existing) {
      sendJson(res, 404, { ok: false, error: 'Idea not found' });
      return;
    }

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
  }
};
