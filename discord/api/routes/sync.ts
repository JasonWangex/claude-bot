/**
 * POST /api/sync/sessions — 全量同步 Claude 会话
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
