/**
 * POST /api/sync/sessions — 全量同步 Claude 会话
 * POST /api/sync/usage   — 全量重算所有 session 的 token/cost
 */

import type { RouteHandler } from '../types.js';
import { sendJson } from '../middleware.js';

export const syncSessions: RouteHandler = async (_req, res, _params, deps) => {
  if (!deps.sessionSyncService) {
    sendJson(res, 503, { ok: false, error: 'Session sync service not available' });
    return;
  }

  const result = deps.sessionSyncService.syncAll();
  sendJson(res, 200, { ok: true, data: result });
};

/** 全量重算所有 session 的 usage（一次性历史同步） */
export const syncUsage: RouteHandler = async (_req, res, _params, deps) => {
  if (!deps.usageReconciler) {
    sendJson(res, 503, { ok: false, error: 'Usage reconciler not available' });
    return;
  }

  const result = await deps.usageReconciler.reconcileAll();
  sendJson(res, 200, { ok: true, data: result });
};
