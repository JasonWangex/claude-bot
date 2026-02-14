/**
 * Prompt Config 路由
 *
 * GET    /api/prompts            — 列出所有 prompt 配置
 * GET    /api/prompts/:key       — 获取单条
 * PATCH  /api/prompts/:key       — 更新模板内容/变量
 * POST   /api/prompts/refresh    — 刷新内存缓存
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import type { PromptConfig } from '../../types/repository.js';

/** PromptConfig → API 响应格式 (snake_case) */
function toApi(config: PromptConfig) {
  return {
    key: config.key,
    category: config.category,
    name: config.name,
    description: config.description,
    template: config.template,
    variables: config.variables,
    parent_key: config.parentKey,
    sort_order: config.sortOrder,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
  };
}

// GET /api/prompts
export const listPrompts: RouteHandler = async (req, res, _params, deps) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const category = url.searchParams.get('category') as 'skill' | 'orchestrator' | null;

  try {
    let items = deps.promptService.getAll();
    if (category) {
      items = items.filter(c => c.category === category);
    }

    sendJson(res, 200, { ok: true, data: items.map(toApi) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list prompts: ${error.message}` });
  }
};

// GET /api/prompts/:key
export const getPrompt: RouteHandler = async (_req, res, params, deps) => {
  try {
    const config = deps.promptService.get(params.key);
    if (!config) {
      sendJson(res, 404, { ok: false, error: `Prompt not found: ${params.key}` });
      return;
    }
    sendJson(res, 200, { ok: true, data: toApi(config) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get prompt: ${error.message}` });
  }
};

interface UpdatePromptRequest {
  template?: string;
  variables?: string[];
  name?: string;
  description?: string;
}

// PATCH /api/prompts/:key
export const updatePrompt: RouteHandler = async (req, res, params, deps) => {
  const body = await readJsonBody<UpdatePromptRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  // 输入验证
  if (body.template !== undefined && typeof body.template !== 'string') {
    sendJson(res, 400, { ok: false, error: 'template must be a string' });
    return;
  }
  if (body.variables !== undefined && (!Array.isArray(body.variables) || !body.variables.every(v => typeof v === 'string'))) {
    sendJson(res, 400, { ok: false, error: 'variables must be a string array' });
    return;
  }

  try {
    const updated = await deps.promptService.update(params.key, body);
    if (!updated) {
      sendJson(res, 404, { ok: false, error: `Prompt not found: ${params.key}` });
      return;
    }

    sendJson(res, 200, { ok: true, data: toApi(updated) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to update prompt: ${error.message}` });
  }
};

// POST /api/prompts/refresh
export const refreshPrompts: RouteHandler = async (_req, res, _params, deps) => {
  try {
    const result = await deps.promptService.refresh();
    sendJson(res, 200, { ok: true, data: result });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to refresh prompts: ${error.message}` });
  }
};
