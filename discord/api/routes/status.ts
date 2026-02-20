/**
 * GET /api/status — 全局状态概览
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { buildChannelTree } from './channel-utils.js';

export const getStatus: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const sessions = deps.stateManager.getAllSessions(guildId);
  const defaultCwd = deps.stateManager.getGuildDefaultCwd(guildId);
  const defaultModel = deps.stateManager.getGuildDefaultModel(guildId) || null;

  sendJson(res, 200, {
    ok: true,
    data: {
      default_cwd: defaultCwd,
      default_model: defaultModel,
      active_channels: sessions.length,
      channels: buildChannelTree(sessions),
    },
  });
};
