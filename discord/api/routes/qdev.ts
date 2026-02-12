/**
 * POST /api/tasks/:threadId/qdev — 快速创建开发任务
 *
 * 流程:
 * 1. 从 parentThreadId 找到 root session
 * 2. 生成分支名和 thread 标题
 * 3. Fork root task（worktree + Discord Forum Post + session）
 * 4. 发送任务描述到新 thread
 * 5. 后台触发 Claude 处理
 * 6. 立即返回 202 Accepted
 */

import { ChannelType } from 'discord.js';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { forkTaskCore } from '../../utils/fork-task.js';
import { generateBranchName } from '../../utils/git-utils.js';
import { generateTopicTitle } from '../../utils/llm.js';
import { logger } from '../../utils/logger.js';

export const qdev: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const threadId = params.threadId;
  const session = deps.stateManager.getSession(guildId, threadId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const body = await readJsonBody<{ description: string; forum_channel_id?: string }>(req);
  if (!body?.description || typeof body.description !== 'string') {
    sendJson(res, 400, { ok: false, error: '"description" field is required' });
    return;
  }

  const description = body.description.trim();

  // 需要 forum_channel_id 来创建新 thread
  let forumChannelId = body.forum_channel_id;
  if (!forumChannelId) {
    try {
      const channel = await deps.client.channels.fetch(threadId);
      if (channel?.isThread() && channel.parent?.type === ChannelType.GuildForum) {
        forumChannelId = channel.parent.id;
      }
    } catch { /* ignore */ }
  }
  if (!forumChannelId) {
    sendJson(res, 400, { ok: false, error: '"forum_channel_id" required or thread must be in a Forum' });
    return;
  }

  try {
    // 1. 并行生成分支名和 thread 标题
    const [branchName, threadTitle] = await Promise.all([
      generateBranchName(description),
      generateTopicTitle(description),
    ]);

    // 2. 找到 root session
    const rootSession = deps.stateManager.getRootSession(guildId, threadId);
    const parentThreadId = rootSession?.threadId ?? threadId;

    // 3. Fork
    const forkResult = await forkTaskCore(guildId, parentThreadId, branchName, forumChannelId, {
      stateManager: deps.stateManager,
      client: deps.client,
      worktreesDir: deps.config.worktreesDir,
    }, threadTitle);

    // 4. 发送任务描述到新 thread
    const newChannel = await deps.client.channels.fetch(forkResult.threadId);
    if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
      await (newChannel as any).send(description);
    }

    // 5. 立即返回
    sendJson(res, 202, {
      ok: true,
      data: {
        thread_id: forkResult.threadId,
        name: forkResult.threadName,
        branch: forkResult.branchName,
        cwd: forkResult.cwd,
        parent_thread_id: parentThreadId,
        status: 'accepted',
      },
    });

    // 6. 后台触发 Claude
    (async () => {
      try {
        logger.info(`[qdev] Background chat started for thread ${forkResult.threadId}`);
        await deps.messageHandler.handleBackgroundChat(guildId, forkResult.threadId, description);
        logger.info(`[qdev] Background chat completed for thread ${forkResult.threadId}`);
      } catch (error: any) {
        logger.error(`[qdev] Background chat failed for thread ${forkResult.threadId}:`, error.message);
        await deps.mq.sendLong(forkResult.threadId, `Error: ${error.message}`).catch(() => {});
      }
    })();
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `qdev failed: ${error.message}` });
  }
};
