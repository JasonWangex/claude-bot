/**
 * Knowledge Base CRUD 路由
 *
 * GET    /api/kb            — 列出条目，支持 ?project=&category=&q= 筛选
 * POST   /api/kb            — 创建条目
 * GET    /api/kb/:id        — 条目详情
 * PATCH  /api/kb/:id        — 更新条目
 * DELETE /api/kb/:id        — 删除条目
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { getDb, KnowledgeBaseRepository } from '../../db/index.js';
import type { KnowledgeBase } from '../../types/repository.js';

function getRepo() {
  return new KnowledgeBaseRepository(getDb());
}

/** KnowledgeBase → API 响应格式 (snake_case) */
function toApiKB(kb: KnowledgeBase) {
  return {
    id: kb.id,
    title: kb.title,
    content: kb.content,
    category: kb.category,
    tags: kb.tags,
    project: kb.project,
    source: kb.source,
    created_at: kb.createdAt,
    updated_at: kb.updatedAt,
  };
}

// GET /api/knowledge-base
export const listKnowledgeBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const project = url.searchParams.get('project');
  const category = url.searchParams.get('category');
  const q = url.searchParams.get('q');

  try {
    const repo = getRepo();
    let items: KnowledgeBase[];

    if (q) {
      items = await repo.search(q);
    } else if (project && category) {
      // 按 project 查再在内存中过滤 category
      const byProject = await repo.findByProject(project);
      items = byProject.filter(kb => kb.category === category);
    } else if (project) {
      items = await repo.findByProject(project);
    } else if (category) {
      items = await repo.findByCategory(category);
    } else {
      items = await repo.getAll();
    }

    sendJson(res, 200, { ok: true, data: items.map(toApiKB) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list knowledge base: ${error.message}` });
  }
};

// GET /api/knowledge-base/:id
export const getKnowledgeBaseEntry: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const kb = await repo.get(params.id);
    if (!kb) {
      sendJson(res, 404, { ok: false, error: 'Knowledge base entry not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: toApiKB(kb) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get knowledge base entry: ${error.message}` });
  }
};

interface CreateKBRequest {
  title: string;
  content: string;
  project: string;
  category?: string;
  tags?: string[];
  source?: string;
}

// POST /api/knowledge-base
export const createKnowledgeBase: RouteHandler = async (req, res) => {
  const body = await readJsonBody<CreateKBRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  if (!body.title || typeof body.title !== 'string') {
    sendJson(res, 400, { ok: false, error: '"title" field is required' });
    return;
  }
  if (!body.content || typeof body.content !== 'string') {
    sendJson(res, 400, { ok: false, error: '"content" field is required' });
    return;
  }
  if (!body.project || typeof body.project !== 'string') {
    sendJson(res, 400, { ok: false, error: '"project" field is required' });
    return;
  }

  try {
    const repo = getRepo();
    const now = Date.now();
    const id = `kb-${now}-${Math.random().toString(36).slice(2, 8)}`;

    const kb: KnowledgeBase = {
      id,
      title: body.title.trim(),
      content: body.content,
      category: body.category || null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      project: body.project.trim(),
      source: body.source || null,
      createdAt: now,
      updatedAt: now,
    };

    await repo.save(kb);
    sendJson(res, 201, { ok: true, data: toApiKB(kb) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create knowledge base entry: ${error.message}` });
  }
};

interface UpdateKBRequest {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  project?: string;
  source?: string;
}

// PATCH /api/knowledge-base/:id
export const updateKnowledgeBase: RouteHandler = async (req, res, params) => {
  const body = await readJsonBody<UpdateKBRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  try {
    const repo = getRepo();
    const kb = await repo.get(params.id);
    if (!kb) {
      sendJson(res, 404, { ok: false, error: 'Knowledge base entry not found' });
      return;
    }

    if (body.title !== undefined) kb.title = body.title.trim();
    if (body.content !== undefined) kb.content = body.content;
    if (body.category !== undefined) kb.category = body.category || null;
    if (body.tags !== undefined && Array.isArray(body.tags)) kb.tags = body.tags;
    if (body.project !== undefined) kb.project = body.project.trim();
    if (body.source !== undefined) kb.source = body.source || null;
    kb.updatedAt = Date.now();

    await repo.save(kb);
    sendJson(res, 200, { ok: true, data: toApiKB(kb) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update knowledge base entry: ${error.message}` });
  }
};

// DELETE /api/knowledge-base/:id
export const deleteKnowledgeBase: RouteHandler = async (_req, res, params) => {
  try {
    const repo = getRepo();
    const deleted = await repo.delete(params.id);
    if (!deleted) {
      sendJson(res, 404, { ok: false, error: 'Knowledge base entry not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to delete knowledge base entry: ${error.message}` });
  }
};
