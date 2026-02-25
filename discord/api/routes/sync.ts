/**
 * POST /api/sync/sessions — 全量同步 Claude 会话
 * POST /api/sync/usage   — 全量重算所有 session 的 token/cost
 * POST /api/sync/discord — 从 Discord 服务器同步 channels 和 categories
 */

import { ChannelType } from 'discord.js';
import type { GuildChannel } from 'discord.js';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';

export const syncSessions: RouteHandler = async (_req, res, _params, deps) => {
  if (!deps.sessionSyncService) {
    sendJson(res, 503, { ok: false, error: 'Session sync service not available' });
    return;
  }

  const result = deps.sessionSyncService.syncAll();
  sendJson(res, 200, { ok: true, data: result });
};

/** 全量重算所有 session 的 usage（一次性历史同步） */
export const syncUsage: RouteHandler = async (_req, res, _params, deps) => {
  if (!deps.usageReconciler) {
    sendJson(res, 503, { ok: false, error: 'Usage reconciler not available' });
    return;
  }

  const result = await deps.usageReconciler.reconcileAll();
  sendJson(res, 200, { ok: true, data: result });
};

/** 从 Discord 服务器同步 channels 和 categories 到数据库 */
export const syncDiscord: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.channelService) {
    sendJson(res, 503, { ok: false, error: 'Channel service not available' });
    return;
  }

  try {
    const guild = await deps.client.guilds.fetch(guildId);
    await guild.channels.fetch(); // 填充缓存

    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
    const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);

    let synced = 0;
    for (const [, channel] of textChannels) {
      await deps.channelService.syncFromDiscord(channel as GuildChannel);
      synced++;
    }

    sendJson(res, 200, { ok: true, data: { synced, categories: categories.size } });
  } catch (e: any) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
};
