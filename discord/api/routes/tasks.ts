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

import { ChannelType } from 'discord.js';
import type { RouteHandler, TaskSummary, CreateTaskRequest, UpdateTaskRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
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

function sessionToSummary(s: Session, children: TaskSummary[]): TaskSummary {
  return {
    thread_id: s.threadId,
    name: s.name,
    cwd: s.cwd,
    model: s.model || null,
    has_session: !!s.claudeSessionId,
    message_count: s.messageHistory.length,
    last_active: s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : null,
    parent_thread_id: s.parentThreadId || null,
    worktree_branch: s.worktreeBranch || null,
    children,
  };
}

function buildTaskTree(sessions: Session[]): TaskSummary[] {
  const liveIds = new Set(sessions.map(s => s.threadId));
  const childMap = new Map<string, Session[]>();

  for (const s of sessions) {
    if (s.parentThreadId && liveIds.has(s.parentThreadId)) {
      const arr = childMap.get(s.parentThreadId) || [];
      arr.push(s);
      childMap.set(s.parentThreadId, arr);
    }
  }

  const topLevel = sessions.filter(s => !s.parentThreadId || !liveIds.has(s.parentThreadId));
  return topLevel.map(s => {
    const children = (childMap.get(s.threadId) || []).map(c => sessionToSummary(c, []));
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
      cwd = resolveCustomPath(body.cwd, deps.stateManager.getGuildDefaultCwd(guildId));
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
    await textChannel.send(
      `Task created: \`${taskName}\`\nWorking directory: \`${cwd}\`${dirCreated ? '\nDirectory auto-created' : ''}`
    );

    deps.stateManager.getOrCreateSession(guildId, textChannel.id, { name: taskName, cwd });

    sendJson(res, 201, {
      ok: true,
      data: { thread_id: textChannel.id, name: taskName, cwd, dir_created: dirCreated },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create task: ${error.message}` });
  }
};

// GET /api/tasks/:threadId
export const getTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const threadId = params.threadId;
  const session = deps.stateManager.getSession(guildId, threadId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const children = deps.stateManager.getChildSessions(guildId, threadId);
  const childSummaries = children.map(c => sessionToSummary(c, []));

  sendJson(res, 200, {
    ok: true,
    data: {
      ...sessionToSummary(session, childSummaries),
      claude_session_id: session.claudeSessionId || null,
      created_at: new Date(session.createdAt).toISOString(),
      plan_mode: !!session.planMode,
    },
  });
};

// PATCH /api/tasks/:threadId
export const updateTask: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const threadId = params.threadId;
  const session = deps.stateManager.getSession(guildId, threadId);
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
    deps.stateManager.setSessionName(guildId, threadId, newName);
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
    deps.stateManager.setSessionModel(guildId, threadId, body.model ?? undefined);
  }

  // cwd
  if (body.cwd !== undefined) {
    const resolvedCwd = resolveCustomPath(body.cwd, deps.stateManager.getGuildDefaultCwd(guildId));
    deps.stateManager.setSessionCwd(guildId, threadId, resolvedCwd);
  }

  const updated = deps.stateManager.getSession(guildId, threadId)!;
  const children = deps.stateManager.getChildSessions(guildId, threadId);
  const childSummaries = children.map(c => sessionToSummary(c, []));

  sendJson(res, 200, {
    ok: true,
    data: {
      ...sessionToSummary(updated, childSummaries),
      claude_session_id: updated.claudeSessionId || null,
      created_at: new Date(updated.createdAt).toISOString(),
      plan_mode: !!updated.planMode,
    },
  });
};

// DELETE /api/tasks/:threadId
export const deleteTask: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const threadId = params.threadId;
  const session = deps.stateManager.getSession(guildId, threadId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cascade = url.searchParams.get('cascade') === 'true';

  const children = deps.stateManager.getChildSessions(guildId, threadId);
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
        deps.stateManager.deleteSession(guildId, child.threadId);
        // Delete child channels
        const childChannel = await deps.client.channels.fetch(child.threadId).catch(() => null);
        if (childChannel && 'delete' in childChannel) {
          await (childChannel as any).delete('Task cascade delete').catch(() => {});
        }
      }
    }

    deps.stateManager.deleteSession(guildId, threadId);
    // Delete the channel
    const channel = await deps.client.channels.fetch(threadId).catch(() => null);
    if (channel && 'delete' in channel) {
      await (channel as any).delete('Task deleted').catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        deleted: [threadId, ...(cascade ? children.map(c => c.threadId) : [])],
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

  const threadId = params.threadId;
  const session = deps.stateManager.getSession(guildId, threadId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  try {
    deps.stateManager.archiveSession(guildId, threadId, undefined, 'API archive');
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

  const threadId = params.threadId;
  const session = deps.stateManager.getSession(guildId, threadId);
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
    const result = await forkTaskCore(guildId, threadId, branchName, categoryId, {
      stateManager: deps.stateManager,
      client: deps.client,
      worktreesDir: deps.config.worktreesDir,
    });

    sendJson(res, 201, {
      ok: true,
      data: {
        thread_id: result.threadId,
        name: result.threadName,
        branch: result.branchName,
        cwd: result.cwd,
        parent_thread_id: threadId,
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Fork failed: ${error.message}` });
  }
};

// ========== Helpers ==========

function getCategoryNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || 'tasks';
}
