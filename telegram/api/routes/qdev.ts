/**
 * POST /api/topics/:topicId/qdev — 快速创建开发任务
 *
 * 流程:
 * 1. 从 parentTopicId 找到 root topic
 * 2. 生成分支名（claude -p，Sonnet，15s 超时）
 * 3. Fork root topic（worktree + Telegram topic + session）
 * 4. 发送任务描述到新 topic
 * 5. 后台触发 Claude 处理
 * 6. 立即返回 202 Accepted
 */

import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { forkTopicCore } from '../../utils/fork-topic.js';
import { generateBranchName } from '../../utils/git-utils.js';
import { logger } from '../../utils/logger.js';

export const qdev: RouteHandler = async (req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const body = await readJsonBody<{ description: string }>(req);
  if (!body?.description || typeof body.description !== 'string') {
    sendJson(res, 400, { ok: false, error: '"description" field is required' });
    return;
  }

  const description = body.description.trim();

  try {
    // 1. 生成分支名
    const branchName = await generateBranchName(description);

    // 2. 找到 root topic
    const rootSession = deps.stateManager.getRootSession(groupId, topicId);
    const parentTopicId = rootSession?.topicId ?? topicId;

    // 3. Fork
    const forkResult = await forkTopicCore(groupId, parentTopicId, branchName, {
      stateManager: deps.stateManager,
      telegram: deps.telegram,
      worktreesDir: deps.config.worktreesDir,
    });

    // 4. 发送任务描述到新 topic
    await deps.telegram.sendMessage(groupId, description, {
      message_thread_id: forkResult.topicId,
      disable_notification: true,
    });

    // 5. 立即返回
    sendJson(res, 202, {
      ok: true,
      data: {
        topic_id: forkResult.topicId,
        name: forkResult.topicName,
        branch: forkResult.branchName,
        cwd: forkResult.cwd,
        parent_topic_id: parentTopicId,
        status: 'accepted',
      },
    });

    // 6. 后台触发 Claude
    (async () => {
      try {
        logger.info(`[qdev] Background chat started for topic ${forkResult.topicId}`);
        await deps.messageHandler.handleBackgroundChat(groupId, forkResult.topicId, description);
        logger.info(`[qdev] Background chat completed for topic ${forkResult.topicId}`);
      } catch (error: any) {
        logger.error(`[qdev] Background chat failed for topic ${forkResult.topicId}:`, error.message);
        await deps.mq.send(groupId, forkResult.topicId, `❌ 错误: ${error.message}`).catch(() => {});
      }
    })();
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `qdev failed: ${error.message}` });
  }
};
