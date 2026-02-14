/**
 * GET /api/commands — 获取所有命令元数据
 */

import type { RouteHandler } from '../types.js';
import { sendJson } from '../middleware.js';
import { COMMAND_METADATA, getAllCategories } from '../../bot/commands/metadata.js';

export const getCommands: RouteHandler = async (_req, res, _params, _deps) => {
  sendJson(res, 200, {
    ok: true,
    data: {
      commands: COMMAND_METADATA,
      categories: getAllCategories(),
    },
  });
};
