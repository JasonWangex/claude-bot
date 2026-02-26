/**
 * POST /api/channels/:channelId/message — 发消息到 Channel
 *
 * 流程:
 * 1. 通过 Discord 发送用户消息到 Thread（可见）
 * 2. 立即返回 202 Accepted（解耦 HTTP 连接与 Claude 执行）
 * 3. 后台调用 handleBackgroundChat
 * 4. 后台发送 Claude 回复到 Discord Thread
 */

import type { RouteHandler, SendMessageRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { logger } from '../../utils/logger.js';

export const sendMessage: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const body = await readJsonBody<SendMessageRequest>(req);
  if (!body?.text || typeof body.text !== 'string') {
    sendJson(res, 400, { ok: false, error: '"text" field is required' });
    return;
  }

  try {
    // 1. 发送用户消息到 Discord Thread（可见）
    const channel = await deps.client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      await (channel as any).send(body.text);
    }
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to send message: ${error.message}` });
    return;
  }

  // 2. 立即返回 202 Accepted
  sendJson(res, 202, {
    ok: true,
    data: { status: 'accepted', channel_id: channelId },
  });

  // 3. 后台执行 Claude
  (async () => {
    try {
      logger.info(`[API] Background chat started for thread ${channelId}`);
      await deps.messageHandler.handleBackgroundChat(guildId, channelId, body.text, 'message');
      logger.info(`[API] Background chat completed for thread ${channelId}`);
    } catch (error: any) {
      logger.error(`[API] Background chat failed for thread ${channelId}:`, error);
      await deps.mq.sendLong(channelId, `Error: ${error.message}`, { silent: true }).catch(() => {});
    }
  })();
};
