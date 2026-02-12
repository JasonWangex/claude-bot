/**
 * GET /api/health — 健康检查
 */

import type { RouteHandler } from '../types.js';
import { sendJson } from '../middleware.js';
import { getAuthorizedGuildId } from '../../utils/env.js';

export const getHealth: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = getAuthorizedGuildId();
  sendJson(res, 200, {
    ok: true,
    data: {
      status: 'running',
      authorized_guild_id: guildId || null,
      api_port: deps.config.apiPort,
    },
  });
};
