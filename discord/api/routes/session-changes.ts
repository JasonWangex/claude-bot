/**
 * Session Changes 路由
 *
 * GET /api/channels/:channelId/changes        — 列出 channel 的文件变更记录（不含 file_changes）
 * GET /api/changes/:id                        — 获取单条记录（含完整 file_changes）
 */

import type { RouteHandler } from '../types.js';
import { sendJson } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { SessionChangesRepo } from '../../db/repo/session-changes-repo.js';

// GET /api/channels/:channelId/changes
export const listSessionChanges: RouteHandler = async (req, res, params) => {
  const { channelId } = params;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
  const size = parseInt(url.searchParams.get('size') || '20', 10) || 20;

  try {
    const repo = new SessionChangesRepo(getDb());
    const result = repo.findByChannel(channelId, { page, size });
    sendJson(res, 200, { ok: true, data: result });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list changes: ${error.message}` });
  }
};

// GET /api/changes/:id
export const getSessionChanges: RouteHandler = async (req, res, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    sendJson(res, 400, { ok: false, error: 'Invalid id' });
    return;
  }

  try {
    const repo = new SessionChangesRepo(getDb());
    const record = repo.getById(id);
    if (!record) {
      sendJson(res, 404, { ok: false, error: `Changes record not found: ${id}` });
      return;
    }
    sendJson(res, 200, { ok: true, data: record });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get changes: ${error.message}` });
  }
};
