/**
 * POST /api/channels/:channelId/code-audit — 在新频道中发起代码审查
 *
 * 流程:
 * 1. 获取当前 session 信息（name、model、cwd）
 * 2. 推断 category_id（未提供时从父 channel 自动获取）
 * 3. 调用 qdevCore，worktree=false（复用当前 worktree），频道名为 "审计:{currentName}"
 * 4. 立即返回 202 Accepted
 * 5. 后台触发 /code-audit
 */

import { ChannelType } from 'discord.js';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { qdevCore } from '../../utils/qdev-core.js';
import { logger } from '../../utils/logger.js';

export const codeAudit: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const body = await readJsonBody<{
    model?: string;
    category_id?: string;
  }>(req);

  // 需要 category_id 来创建新 channel
  let categoryId = body?.category_id;
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

  const auditChannelName = `审计:${session.name || channelId.slice(-6)}`;
  const auditPrompt = '/code-audit';
  const model = body?.model?.trim() || session.model || undefined;

  try {
    const result = await qdevCore({
      guildId,
      channelId,
      description: auditPrompt,
      model,
      categoryId,
      channelName: auditChannelName,
      worktree: false,
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
        cwd: result.cwd,
        parent_channel_id: result.parentChannelId,
        status: 'accepted',
      },
    });

    // 后台触发 /code-audit
    (async () => {
      try {
        logger.info(`[code-audit] Background chat started for channel ${result.channelId}`);
        await deps.messageHandler.handleBackgroundChat(guildId, result.channelId, auditPrompt, 'code-audit');
        logger.info(`[code-audit] Background chat completed for channel ${result.channelId}`);
      } catch (error: any) {
        logger.error(`[code-audit] Background chat failed for channel ${result.channelId}:`, error);
        await deps.mq.sendLong(result.channelId, `Error: ${error.message}`, { silent: true }).catch(() => {});
      }
    })();
  } catch (error: any) {
    const isUserError = error.message?.startsWith('Invalid ') || error.name === 'GitOperationError';
    sendJson(res, isUserError ? 400 : 500, { ok: false, error: `code-audit failed: ${error.message}` });
  }
};
