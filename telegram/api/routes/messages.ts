/**
 * POST /api/topics/:topicId/message — 发消息到 Topic（唯一发 Telegram 的端点）
 *
 * 流程:
 * 1. 通过 Telegram 发送用户消息到 Topic（可见）
 * 2. 立即返回 202 Accepted（解耦 HTTP 连接与 Claude 执行）
 * 3. 后台调用 handleBackgroundChat
 * 4. 后台发送 Claude 回复到 Telegram Topic
 */

import type { RouteHandler, SendMessageRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { sendLongMessageDirect } from '../../bot/message-utils.js';
import { logger } from '../../utils/logger.js';

export const sendMessage: RouteHandler = async (req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const body = await readJsonBody<SendMessageRequest>(req);
  if (!body?.text || typeof body.text !== 'string') {
    sendJson(res, 400, { ok: false, error: '"text" field is required' });
    return;
  }

  try {
    // 1. 发送用户消息到 Telegram Topic（可见）
    await deps.telegram.sendMessage(groupId, body.text, {
      message_thread_id: topicId,
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to send message: ${error.message}` });
    return;
  }

  // 2. 立即返回 202 Accepted — 解耦 HTTP 生命周期和 Claude 执行
  sendJson(res, 202, {
    ok: true,
    data: { status: 'accepted', topic_id: topicId },
  });

  // 3. 后台执行 Claude 并发送回复（不依赖 HTTP 连接）
  (async () => {
    try {
      logger.info(`[API] Background chat started for topic ${topicId}`);
      const response = await deps.messageHandler.handleBackgroundChat(groupId, topicId, body.text);

      // 4. 发送 Claude 回复到 Telegram Topic
      if (response.result) {
        await sendLongMessageDirect(deps.telegram, groupId, topicId, response.result);
      }
      logger.info(`[API] Background chat completed for topic ${topicId}, length: ${response.result.length}`);
    } catch (error: any) {
      logger.error(`[API] Background chat failed for topic ${topicId}:`, error.message);
      // 发送错误到 Telegram Topic，确保用户能看到
      await sendLongMessageDirect(deps.telegram, groupId, topicId, `❌ 错误: ${error.message}`).catch(() => {});
    }
  })();
};
