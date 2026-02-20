/**
 * Channel CRUD 路由
 *
 * GET    /api/channels              — 列出所有 Channel
 * POST   /api/channels              — 创建 Channel (Category + Text Channel)
 * GET    /api/channels/:channelId   — Channel 详情
 * PATCH  /api/channels/:channelId   — 更新 Channel
 * DELETE /api/channels/:channelId   — 删除 Channel (?cascade=true 级联删子)
 * POST   /api/channels/:channelId/archive — 归档
 * POST   /api/channels/:channelId/fork    — Fork
 */

import { ChannelType, EmbedBuilder } from 'discord.js';
import type { RouteHandler, ChannelSummary, CreateChannelRequest, UpdateChannelRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { EmbedColors } from '../../bot/message-queue.js';
import { MODEL_OPTIONS } from '../../bot/commands/task.js';
import {
  resolveTopicWorkDir,
  ensureProjectDir,
  resolveCustomPath,
} from '../../utils/topic-path.js';
import { forkTaskCore } from '../../utils/fork-task.js';
import { ChannelRepository } from '../../db/repo/channel-repo.js';
import { logger } from '../../utils/logger.js';
import { sessionToSummary, buildChannelTree } from './channel-utils.js';

// GET /api/channels
export const listChannels: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const statusFilter = url.searchParams.get('status') || 'active';

  if (statusFilter === 'all') {
    // 从数据库查所有 channel，合并内存中的活跃状态
    const channelRepo = new ChannelRepository(deps.db);
    const allChannels = await channelRepo.getByGuild(guildId);
    const activeSessions = deps.stateManager.getAllSessions(guildId);
    const activeIds = new Set(activeSessions.map(s => s.channelId));

    const summaries: ChannelSummary[] = allChannels.map(ch => {
      // 优先从内存取活跃 session 数据
      const activeSession = activeSessions.find(s => s.channelId === ch.id);
      if (activeSession) {
        return {
          ...sessionToSummary(activeSession, []),
          status: 'active' as const,
        };
      }
      return {
        channel_id: ch.id,
        name: ch.name,
        cwd: ch.cwd,
        model: null,
        has_session: false,
        message_count: ch.messageCount,
        created_at: ch.createdAt,
        last_message: ch.lastMessage || null,
        last_message_at: ch.lastMessageAt || null,
        parent_channel_id: ch.parentChannelId || null,
        worktree_branch: ch.worktreeBranch || null,
        status: ch.status,
        children: [],
      };
    });

    // 构建树结构
    const idSet = new Set(summaries.map(s => s.channel_id));
    const childMap = new Map<string, ChannelSummary[]>();
    for (const s of summaries) {
      if (s.parent_channel_id && idSet.has(s.parent_channel_id)) {
        const arr = childMap.get(s.parent_channel_id) || [];
        arr.push(s);
        childMap.set(s.parent_channel_id, arr);
      }
    }
    const topLevel = summaries
      .filter(s => !s.parent_channel_id || !idSet.has(s.parent_channel_id))
      .map(s => ({ ...s, children: childMap.get(s.channel_id) || [] }));

    sendJson(res, 200, { ok: true, data: topLevel });
  } else {
    // 默认：只返回活跃 channel（从内存）
    const sessions = deps.stateManager.getAllSessions(guildId);
    sendJson(res, 200, { ok: true, data: buildChannelTree(sessions) });
  }
};

// POST /api/channels
export const createChannel: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const body = await readJsonBody<CreateChannelRequest>(req);
  if (!body?.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }

  const channelName = body.name.trim();
  if (!channelName || channelName.length > 100) {
    sendJson(res, 400, { ok: false, error: 'Name must be 1-100 characters' });
    return;
  }

  try {
    let cwd: string;
    let dirCreated = false;

    if (body.cwd) {
      cwd = resolveCustomPath(body.cwd, deps.stateManager.getGuildDefaultCwd(guildId), deps.config.projectsRoot);
      const dirResult = await ensureProjectDir(cwd, deps.config.autoCreateProjectDir);
      dirCreated = dirResult.created;
      if (!dirResult.exists && !deps.config.autoCreateProjectDir) {
        sendJson(res, 400, { ok: false, error: `Directory does not exist: ${cwd}` });
        return;
      }
    } else {
      const occupiedPaths = deps.stateManager.getOccupiedWorkDirs(guildId);
      cwd = await resolveTopicWorkDir(
        channelName, deps.config.projectsRoot, deps.config.topicDirNaming, occupiedPaths,
      );
      const dirResult = await ensureProjectDir(cwd, deps.config.autoCreateProjectDir);
      dirCreated = dirResult.created;
      if (!dirResult.exists && !deps.config.autoCreateProjectDir) {
        sendJson(res, 400, { ok: false, error: `Derived directory does not exist: ${cwd}` });
        return;
      }
    }

    // 查找或创建 Category
    const guild = await deps.client.guilds.fetch(guildId);
    const categoryName = body.category || getCategoryNameFromCwd(cwd);
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === categoryName,
    );

    if (!category) {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        reason: `Auto-created by Claude Bot for project: ${categoryName}`,
      });
      logger.info(`Created Category: ${categoryName}`);
    }

    // 创建 Text Channel (under Category)
    const textChannel = await guild.channels.create({
      name: channelName.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `Channel: ${channelName}`,
    });

    // 发送初始消息
    const initEmbed = new EmbedBuilder()
      .setColor(EmbedColors.PURPLE)
      .setDescription(`[channel] Channel created: \`${channelName}\`\nWorking directory: \`${cwd}\`${dirCreated ? '\nDirectory auto-created' : ''}`.slice(0, 4096));
    await textChannel.send({ embeds: [initEmbed] });

    deps.stateManager.getOrCreateSession(guildId, textChannel.id, { name: channelName, cwd });

    // 同步到 channels 表
    if (deps.channelService) {
      await deps.channelService.ensureChannel(textChannel.id, guildId, channelName, cwd);
    }

    sendJson(res, 201, {
      ok: true,
      data: { channel_id: textChannel.id, name: channelName, cwd, dir_created: dirCreated },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create channel: ${error.message}` });
  }
};

// GET /api/channels/:channelId
export const getChannel: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Channel not found' });
    return;
  }

  const children = deps.stateManager.getChildSessions(guildId, channelId);
  const childSummaries = children.map(c => sessionToSummary(c, []));

  sendJson(res, 200, {
    ok: true,
    data: {
      ...sessionToSummary(session, childSummaries),
      claude_session_id: session.claudeSessionId || null,
      plan_mode: !!session.planMode,
    },
  });
};

// PATCH /api/channels/:channelId
export const updateChannel: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Channel not found' });
    return;
  }

  const body = await readJsonBody<UpdateChannelRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  // name
  if (body.name !== undefined) {
    const newName = body.name.trim();
    if (!newName || newName.length > 100) {
      sendJson(res, 400, { ok: false, error: 'Name must be 1-100 characters' });
      return;
    }
    // 尝试更新 Discord Channel 名
    try {
      const channel = await deps.client.channels.fetch(channelId);
      if (channel && 'setName' in channel) {
        await (channel as any).setName(newName.slice(0, 100));
      }
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: `Channel rename failed: ${error.message}` });
      return;
    }
    deps.stateManager.setSessionName(guildId, channelId, newName);
  }

  // model
  if ('model' in body) {
    if (body.model !== null && body.model !== undefined) {
      const valid = MODEL_OPTIONS.some(m => m.id === body.model);
      if (!valid) {
        sendJson(res, 400, { ok: false, error: `Invalid model: ${body.model}` });
        return;
      }
    }
    deps.stateManager.setSessionModel(guildId, channelId, body.model ?? undefined);
  }

  // cwd
  if (body.cwd !== undefined) {
    const resolvedCwd = resolveCustomPath(body.cwd, deps.stateManager.getGuildDefaultCwd(guildId), deps.config.projectsRoot);
    deps.stateManager.setSessionCwd(guildId, channelId, resolvedCwd);
  }

  const updated = deps.stateManager.getSession(guildId, channelId)!;
  const children = deps.stateManager.getChildSessions(guildId, channelId);
  const childSummaries = children.map(c => sessionToSummary(c, []));

  sendJson(res, 200, {
    ok: true,
    data: {
      ...sessionToSummary(updated, childSummaries),
      claude_session_id: updated.claudeSessionId || null,
      plan_mode: !!updated.planMode,
    },
  });
};

// DELETE /api/channels/:channelId
export const deleteChannel: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Channel not found' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cascade = url.searchParams.get('cascade') === 'true';

  const children = deps.stateManager.getChildSessions(guildId, channelId);
  if (children.length > 0 && !cascade) {
    sendJson(res, 400, {
      ok: false,
      error: `Channel has ${children.length} child channel(s). Use ?cascade=true to delete all.`,
    });
    return;
  }

  try {
    if (cascade) {
      for (const child of children) {
        deps.stateManager.deleteSession(guildId, child.channelId);
        const childChannel = await deps.client.channels.fetch(child.channelId).catch(() => null);
        if (childChannel && 'delete' in childChannel) {
          await (childChannel as any).delete('Channel cascade delete').catch(() => {});
        }
      }
    }

    deps.stateManager.deleteSession(guildId, channelId);
    const channel = await deps.client.channels.fetch(channelId).catch(() => null);
    if (channel && 'delete' in channel) {
      await (channel as any).delete('Channel deleted').catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        deleted: [channelId, ...(cascade ? children.map(c => c.channelId) : [])],
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Delete failed: ${error.message}` });
  }
};

// POST /api/channels/:channelId/archive
export const archiveChannel: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Channel not found' });
    return;
  }

  try {
    deps.stateManager.archiveSession(guildId, channelId, undefined, 'API archive');
    const channel = await deps.client.channels.fetch(channelId).catch(() => null);
    if (channel && 'delete' in channel) {
      await (channel as any).delete('Channel archived').catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      data: { success: true, message: `Channel "${session.name}" archived` },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Archive failed: ${error.message}` });
  }
};

// POST /api/channels/:channelId/fork
export const forkChannel: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Channel not found' });
    return;
  }

  const body = await readJsonBody<{ branch: string; category_id?: string }>(req);
  if (!body?.branch || typeof body.branch !== 'string') {
    sendJson(res, 400, { ok: false, error: '"branch" field is required' });
    return;
  }

  const branchName = body.branch.trim();
  if (!branchName || /\s/.test(branchName) || branchName.startsWith('-') || !/^[\w.\-/]+$/.test(branchName)) {
    sendJson(res, 400, { ok: false, error: 'Invalid branch name' });
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

  try {
    const result = await forkTaskCore(guildId, channelId, branchName, categoryId, {
      stateManager: deps.stateManager,
      client: deps.client,
      worktreesDir: deps.config.worktreesDir,
      channelService: deps.channelService,
    });

    sendJson(res, 201, {
      ok: true,
      data: {
        channel_id: result.channelId,
        name: result.channelName,
        branch: result.branchName,
        cwd: result.cwd,
        parent_channel_id: channelId,
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Fork failed: ${error.message}` });
  }
};

// ========== Helpers ==========

function getCategoryNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || 'channels';
}
