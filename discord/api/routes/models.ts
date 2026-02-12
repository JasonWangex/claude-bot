/**
 * GET  /api/models         — 可用模型列表 + 当前全局默认
 * PUT  /api/models/default  — 设置全局默认模型
 */

import type { RouteHandler, SetDefaultModelRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { MODEL_OPTIONS } from '../../bot/commands/task.js';

export const getModels: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const defaultModel = deps.stateManager.getGuildDefaultModel(guildId) || null;

  sendJson(res, 200, {
    ok: true,
    data: {
      models: MODEL_OPTIONS.map(m => ({ id: m.id, label: m.label })),
      default_model: defaultModel,
    },
  });
};

export const setDefaultModel: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const body = await readJsonBody<SetDefaultModelRequest>(req);
  if (!body?.model || typeof body.model !== 'string') {
    sendJson(res, 400, { ok: false, error: '"model" field is required' });
    return;
  }

  const valid = MODEL_OPTIONS.some(m => m.id === body.model);
  if (!valid) {
    sendJson(res, 400, {
      ok: false,
      error: `Invalid model. Available: ${MODEL_OPTIONS.map(m => m.id).join(', ')}`,
    });
    return;
  }

  deps.stateManager.setGuildDefaultModel(guildId, body.model);

  sendJson(res, 200, {
    ok: true,
    data: {
      default_model: body.model,
      label: MODEL_OPTIONS.find(m => m.id === body.model)?.label,
    },
  });
};
