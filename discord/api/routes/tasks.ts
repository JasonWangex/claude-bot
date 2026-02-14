/**
 * Task (Channel) CRUD 路由
 *
 * GET    /api/tasks              — 列出所有 Task
 * POST   /api/tasks              — 创建 Task (Category + Text Channel)
 * GET    /api/tasks/:threadId    — Task 详情
 * PATCH  /api/tasks/:threadId    — 更新 Task
 * DELETE /api/tasks/:threadId    — 删除 Task (?cascade=true 级联删子)
 * POST   /api/tasks/:threadId/archive — 归档
 * POST   /api/tasks/:threadId/fork    — Fork
 */

import { ChannelType, EmbedBuilder } from 'discord.js';
import type { RouteHandler, TaskSummary, CreateTaskRequest, UpdateTaskRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { EmbedColors } from '../../bot/message-queue.js';
import type { Session } from '../../types/index.js';
import { MODEL_OPTIONS } from '../../bot/commands/task.js';
import {
  normalizeTopicName,
  resolveTopicWorkDir,
  ensureProjectDir,
  resolveCustomPath,
} from '../../utils/topic-path.js';
import { forkTaskCore } from '../../utils/fork-task.js';
import { logger } from '../../utils/logger.js';
import { getDb, InteractionLogRepository } from '../../db/index.js';

// 模块级别复用 InteractionLogRepository 实例，避免重复 prepare statement
let interactionRepo: InteractionLogRepository | null = null;
function getInteractionRepo(): InteractionLogRepository {
  if (!interactionRepo) {
    interactionRepo = new InteractionLogRepository(getDb());
  }
  return interactionRepo;
}

function sessionToSummary(s: Session, children: TaskSummary[]): TaskSummary {
  return {
    channel_id: s.channelId,
    name: s.name,
    cwd: s.cwd,
    model: s.model || null,
    has_session: !!s.claudeSessionId,
    message_count: s.messageCount,
    created_at: s.createdAt,
    last_message: s.lastMessage || null,
    last_message_at: s.lastMessageAt || null,
    parent_channel_id: s.parentChannelId || null,
    worktree_branch: s.worktreeBranch || null,
    children,
  };
}

function buildTaskTree(sessions: Session[]): TaskSummary[] {
  const liveIds = new Set(sessions.map(s => s.channelId));
  const childMap = new Map<string, Session[]>();

  for (const s of sessions) {
    if (s.parentChannelId && liveIds.has(s.parentChannelId)) {
      const arr = childMap.get(s.parentChannelId) || [];
      arr.push(s);
      childMap.set(s.parentChannelId, arr);
    }
  }

  const topLevel = sessions.filter(s => !s.parentChannelId || !liveIds.has(s.parentChannelId));
  return topLevel.map(s => {
    const children = (childMap.get(s.channelId) || []).map(c => sessionToSummary(c, []));
    return sessionToSummary(s, children);
  });
}

// GET /api/tasks
export const listTasks: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const sessions = deps.stateManager.getAllSessions(guildId);
  sendJson(res, 200, { ok: true, data: buildTaskTree(sessions) });
};

// POST /api/tasks
export const createTask: RouteHandler = async (req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const body = await readJsonBody<CreateTaskRequest>(req);
  if (!body?.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }

  const taskName = body.name.trim();
  if (!taskName || taskName.length > 100) {
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
        taskName, deps.config.projectsRoot, deps.config.topicDirNaming, occupiedPaths,
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
      name: taskName.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `Task: ${taskName}`,
    });

    // 发送初始消息
    const initEmbed = new EmbedBuilder()
      .setColor(EmbedColors.PURPLE)
      .setDescription(`[task] Task created: \`${taskName}\`\nWorking directory: \`${cwd}\`${dirCreated ? '\nDirectory auto-created' : ''}`.slice(0, 4096));
    await textChannel.send({ embeds: [initEmbed] });

    deps.stateManager.getOrCreateSession(guildId, textChannel.id, { name: taskName, cwd });

    // 同步到 channels 表
    if (deps.channelService) {
      await deps.channelService.ensureChannel(textChannel.id, guildId, taskName, cwd);
    }

    sendJson(res, 201, {
      ok: true,
      data: { channel_id: textChannel.id, name: taskName, cwd, dir_created: dirCreated },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create task: ${error.message}` });
  }
};

// GET /api/tasks/:threadId
export const getTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
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
      message_history: session.messageHistory,
    },
  });
};

// PATCH /api/tasks/:threadId
export const updateTask: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const body = await readJsonBody<UpdateTaskRequest>(req);
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
      const channel = await deps.client.channels.fetch(threadId);
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
      message_history: updated.messageHistory,
    },
  });
};

// DELETE /api/tasks/:threadId
export const deleteTask: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cascade = url.searchParams.get('cascade') === 'true';

  const children = deps.stateManager.getChildSessions(guildId, channelId);
  if (children.length > 0 && !cascade) {
    sendJson(res, 400, {
      ok: false,
      error: `Task has ${children.length} child task(s). Use ?cascade=true to delete all.`,
    });
    return;
  }

  try {
    if (cascade) {
      for (const child of children) {
        deps.stateManager.deleteSession(guildId, child.channelId);
        // Delete child channels
        const childChannel = await deps.client.channels.fetch(child.channelId).catch(() => null);
        if (childChannel && 'delete' in childChannel) {
          await (childChannel as any).delete('Task cascade delete').catch(() => {});
        }
      }
    }

    deps.stateManager.deleteSession(guildId, channelId);
    // Delete the channel
    const channel = await deps.client.channels.fetch(threadId).catch(() => null);
    if (channel && 'delete' in channel) {
      await (channel as any).delete('Task deleted').catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        deleted: [threadId, ...(cascade ? children.map(c => c.channelId) : [])],
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Delete failed: ${error.message}` });
  }
};

// POST /api/tasks/:threadId/archive
export const archiveTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  try {
    deps.stateManager.archiveSession(guildId, channelId, undefined, 'API archive');
    const channel = await deps.client.channels.fetch(threadId).catch(() => null);
    if (channel && 'delete' in channel) {
      await (channel as any).delete('Task archived').catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      data: { success: true, message: `Task "${session.name}" archived` },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Archive failed: ${error.message}` });
  }
};

// POST /api/tasks/:threadId/fork
export const forkTask: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
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
    // 尝试从当前 channel 的 parentId 获取 Category
    try {
      const channel = await deps.client.channels.fetch(threadId);
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
        name: result.threadName,
        branch: result.branchName,
        cwd: result.cwd,
        parent_channel_id: threadId,
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Fork failed: ${error.message}` });
  }
};

// GET /api/tasks/:threadId/interactions
export const getTaskInteractions: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  try {
    const interactionRepo = getInteractionRepo();

    // 如果没有 claudeSessionId，返回空列表
    if (!session.claudeSessionId) {
      sendJson(res, 200, {
        ok: true,
        data: {
          task_id: threadId,
          session_id: null,
          interactions: [],
        },
      });
      return;
    }

    const interactions = interactionRepo.findBySession(session.claudeSessionId);

    sendJson(res, 200, {
      ok: true,
      data: {
        task_id: threadId,
        session_id: session.claudeSessionId,
        interactions,
      },
    });
  } catch (error: any) {
    logger.error(`Failed to get task interactions: ${error.message}`, error);
    sendJson(res, 500, { ok: false, error: `Failed to get interactions: ${error.message}` });
  }
};

// ========== Helpers ==========

function getCategoryNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || 'tasks';
}
