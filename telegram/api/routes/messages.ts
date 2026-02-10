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
      disable_notification: true,
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

  // 3. 后台执行 Claude（sendChatInternal 已包含完整的流式进度和消息发送）
  (async () => {
    try {
      logger.info(`[API] Background chat started for topic ${topicId}`);
      await deps.messageHandler.handleBackgroundChat(groupId, topicId, body.text);
      logger.info(`[API] Background chat completed for topic ${topicId}`);
    } catch (error: any) {
      logger.error(`[API] Background chat failed for topic ${topicId}:`, error.message);
      await deps.mq.send(groupId, topicId, `❌ 错误: ${error.message}`).catch(() => {});
    }
  })();
};
