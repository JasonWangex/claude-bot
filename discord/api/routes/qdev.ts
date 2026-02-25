/**
 * POST /api/channels/:channelId/qdev — 快速创建开发任务
 *
 * 流程:
 * 1. 解析并校验请求体参数
 * 2. 推断 category_id（未提供时从父 channel 自动获取）
 * 3. 调用 qdevCore 执行核心逻辑
 * 4. 立即返回 202 Accepted
 * 5. 后台触发 Claude 处理
 */

import { ChannelType } from 'discord.js';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { qdevCore } from '../../utils/qdev-core.js';
import { logger } from '../../utils/logger.js';

export const qdev: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const body = await readJsonBody<{
    description: string;
    model?: string;
    category_id?: string;
    branch_name?: string;
    channel_name?: string;
    base_branch?: string;
    worktree?: boolean;
  }>(req);

  if (!body?.description || typeof body.description !== 'string') {
    sendJson(res, 400, { ok: false, error: '"description" field is required' });
    return;
  }

  // 需要 category_id 来创建新 channel
  let categoryId = body.category_id;
  if (!categoryId) {
    try {
      const channel = await deps.client.channels.fetch(channelId);
      if (channel && 'parentId' in channel && channel.parentId) {
        const parent = await deps.client.channels.fetch(channel.parentId);
        if (parent && parent.type === ChannelType.GuildCategory) {
          categoryId = parent.id;
        }
      }
    } catch { /* ignore */ }
  }
  if (!categoryId) {
    sendJson(res, 400, { ok: false, error: '"category_id" required or channel must be in a Category' });
    return;
  }

  const description = body.description.trim();

  try {
    const result = await qdevCore({
      guildId,
      channelId,
      description,
      model: body.model?.trim() || undefined,
      categoryId,
      branchName: body.branch_name?.trim() || undefined,
      channelName: body.channel_name?.trim() || undefined,
      baseBranch: body.base_branch?.trim() || undefined,
      worktree: body.worktree !== false,  // 默认 true
    }, {
      stateManager: deps.stateManager,
      client: deps.client,
      worktreesDir: deps.config.worktreesDir,
      channelService: deps.channelService,
    });

    // 立即返回
    sendJson(res, 202, {
      ok: true,
      data: {
        channel_id: result.channelId,
        name: result.channelName,
        branch: result.branchName || null,
        cwd: result.cwd,
        parent_channel_id: result.parentChannelId,
        status: 'accepted',
      },
    });

    // 后台触发 Claude
    (async () => {
      try {
        logger.info(`[qdev] Background chat started for channel ${result.channelId}`);
        await deps.messageHandler.handleBackgroundChat(guildId, result.channelId, description);
        logger.info(`[qdev] Background chat completed for channel ${result.channelId}`);
      } catch (error: any) {
        logger.error(`[qdev] Background chat failed for channel ${result.channelId}:`, error);
        await deps.mq.sendLong(result.channelId, `Error: ${error.message}`, { silent: true }).catch(() => {});
      }
    })();
  } catch (error: any) {
    // 用户输入错误（参数校验失败、branch 不存在等 git 错误）→ 400；其余 → 500
    const isUserError = error.message?.startsWith('Invalid ') ||
                        error.name === 'GitOperationError';
    sendJson(res, isUserError ? 400 : 500, { ok: false, error: `qdev failed: ${error.message}` });
  }
};
