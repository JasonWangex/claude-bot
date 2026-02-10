/**
 * GET /api/health — 健康检查
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { getAuthorizedChatId } from '../../utils/env.js';

export const getHealth: RouteHandler = async (_req, res, _params, deps) => {
  const chatId = getAuthorizedChatId();
  sendJson(res, 200, {
    ok: true,
    data: {
      status: 'running',
      authorized_chat_id: chatId || null,
      api_port: deps.config.apiPort,
    },
  });
};
