/**
 * Topic CRUD 路由
 *
 * GET    /api/topics              — 列出所有 Topic
 * POST   /api/topics              — 创建 Topic
 * GET    /api/topics/:topicId     — Topic 详情
 * PATCH  /api/topics/:topicId     — 更新 Topic
 * DELETE /api/topics/:topicId     — 删除 Topic (?cascade=true 级联删子)
 * POST   /api/topics/:topicId/archive — 归档
 * POST   /api/topics/:topicId/fork    — Fork
 */

import type { RouteHandler, TopicSummary, CreateTopicRequest, UpdateTopicRequest } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import type { Session } from '../../types/index.js';
import { MODEL_OPTIONS } from '../../bot/commands.js';
import {
  normalizeTopicName,
  resolveTopicWorkDir,
  ensureProjectDir,
  resolveCustomPath,
} from '../../utils/topic-path.js';
import { isGitRepo, getRepoName, createWorktree } from '../../utils/git-utils.js';
import { resolve } from 'path';
import { mkdir } from 'fs/promises';

function sessionToSummary(s: Session, children: TopicSummary[]): TopicSummary {
  return {
    topic_id: s.topicId,
    name: s.name,
    cwd: s.cwd,
    model: s.model || null,
    has_session: !!s.claudeSessionId,
    message_count: s.messageHistory.length,
    last_active: s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : null,
    parent_topic_id: s.parentTopicId || null,
    worktree_branch: s.worktreeBranch || null,
    children,
  };
}

function buildTopicTree(sessions: Session[]): TopicSummary[] {
  const liveIds = new Set(sessions.map(s => s.topicId));
  const childMap = new Map<number, Session[]>();

  for (const s of sessions) {
    if (s.parentTopicId && liveIds.has(s.parentTopicId)) {
      const arr = childMap.get(s.parentTopicId) || [];
      arr.push(s);
      childMap.set(s.parentTopicId, arr);
    }
  }

  const topLevel = sessions.filter(s => !s.parentTopicId || !liveIds.has(s.parentTopicId));
  return topLevel.map(s => {
    const children = (childMap.get(s.topicId) || []).map(c => sessionToSummary(c, []));
    return sessionToSummary(s, children);
  });
}

// GET /api/topics
export const listTopics: RouteHandler = async (_req, res, _params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const sessions = deps.stateManager.getAllSessions(groupId);
  sendJson(res, 200, { ok: true, data: buildTopicTree(sessions) });
};

// POST /api/topics
export const createTopic: RouteHandler = async (req, res, _params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const body = await readJsonBody<CreateTopicRequest>(req);
  if (!body?.name || typeof body.name !== 'string') {
    sendJson(res, 400, { ok: false, error: '"name" field is required' });
    return;
  }

  const topicName = body.name.trim();
  if (!topicName || topicName.length > 128) {
    sendJson(res, 400, { ok: false, error: 'Name must be 1-128 characters' });
    return;
  }

  try {
    let cwd: string;
    let dirCreated = false;

    if (body.cwd) {
      cwd = resolveCustomPath(body.cwd, deps.stateManager.getGroupDefaultCwd(groupId));
      const dirResult = await ensureProjectDir(cwd, deps.config.autoCreateProjectDir);
      dirCreated = dirResult.created;
      if (!dirResult.exists && !deps.config.autoCreateProjectDir) {
        sendJson(res, 400, { ok: false, error: `Directory does not exist: ${cwd}` });
        return;
      }
    } else {
      const occupiedPaths = deps.stateManager.getOccupiedWorkDirs(groupId);
      cwd = await resolveTopicWorkDir(
        topicName, deps.config.projectsRoot, deps.config.topicDirNaming, occupiedPaths,
      );
      const dirResult = await ensureProjectDir(cwd, deps.config.autoCreateProjectDir);
      dirCreated = dirResult.created;
      if (!dirResult.exists && !deps.config.autoCreateProjectDir) {
        sendJson(res, 400, { ok: false, error: `Derived directory does not exist: ${cwd}` });
        return;
      }
    }

    // 调用 Telegram API 创建 Forum Topic
    const forumTopic = await deps.telegram.createForumTopic(groupId, topicName, {
      icon_color: 0x6FB9F0,
    });

    const newTopicId = forumTopic.message_thread_id;
    deps.stateManager.getOrCreateSession(groupId, newTopicId, { name: topicName, cwd });
    deps.stateManager.setSessionIcon(groupId, newTopicId, forumTopic.icon_color);

    sendJson(res, 201, {
      ok: true,
      data: { topic_id: newTopicId, name: topicName, cwd, dir_created: dirCreated },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to create topic: ${error.message}` });
  }
};

// GET /api/topics/:topicId
export const getTopic: RouteHandler = async (_req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const children = deps.stateManager.getChildSessions(groupId, topicId);
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

// PATCH /api/topics/:topicId
export const updateTopic: RouteHandler = async (req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const body = await readJsonBody<UpdateTopicRequest>(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: 'Request body required' });
    return;
  }

  // name
  if (body.name !== undefined) {
    const newName = body.name.trim();
    if (!newName || newName.length > 128) {
      sendJson(res, 400, { ok: false, error: 'Name must be 1-128 characters' });
      return;
    }
    try {
      await deps.telegram.editForumTopic(groupId, topicId, { name: newName });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: `Telegram rename failed: ${error.message}` });
      return;
    }
    deps.stateManager.setSessionName(groupId, topicId, newName);
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
    deps.stateManager.setSessionModel(groupId, topicId, body.model ?? undefined);
  }

  // cwd
  if (body.cwd !== undefined) {
    const resolvedCwd = resolveCustomPath(body.cwd, deps.stateManager.getGroupDefaultCwd(groupId));
    deps.stateManager.setSessionCwd(groupId, topicId, resolvedCwd);
  }

  // 返回更新后的 session
  const updated = deps.stateManager.getSession(groupId, topicId)!;
  const children = deps.stateManager.getChildSessions(groupId, topicId);
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

// DELETE /api/topics/:topicId
export const deleteTopic: RouteHandler = async (req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cascade = url.searchParams.get('cascade') === 'true';

  const children = deps.stateManager.getChildSessions(groupId, topicId);
  if (children.length > 0 && !cascade) {
    sendJson(res, 400, {
      ok: false,
      error: `Topic has ${children.length} child topic(s). Use ?cascade=true to delete all.`,
    });
    return;
  }

  try {
    if (cascade) {
      for (const child of children) {
        deps.stateManager.deleteSession(groupId, child.topicId);
        await deps.telegram.deleteForumTopic(groupId, child.topicId).catch(() => {});
      }
    }

    deps.stateManager.deleteSession(groupId, topicId);
    await deps.telegram.deleteForumTopic(groupId, topicId).catch(() => {});

    sendJson(res, 200, {
      ok: true,
      data: {
        deleted: [topicId, ...(cascade ? children.map(c => c.topicId) : [])],
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Delete failed: ${error.message}` });
  }
};

// POST /api/topics/:topicId/archive
export const archiveTopic: RouteHandler = async (_req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  try {
    deps.stateManager.archiveSession(groupId, topicId, undefined, 'API archive');
    await deps.telegram.closeForumTopic(groupId, topicId).catch(() => {});

    sendJson(res, 200, {
      ok: true,
      data: { success: true, message: `Topic "${session.name}" archived` },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Archive failed: ${error.message}` });
  }
};

// POST /api/topics/:topicId/fork
export const forkTopic: RouteHandler = async (req, res, params, deps) => {
  const groupId = requireAuth(res);
  if (!groupId) return;

  const topicId = parseInt(params.topicId, 10);
  const session = deps.stateManager.getSession(groupId, topicId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Topic not found' });
    return;
  }

  const body = await readJsonBody<{ branch: string }>(req);
  if (!body?.branch || typeof body.branch !== 'string') {
    sendJson(res, 400, { ok: false, error: '"branch" field is required' });
    return;
  }

  const branchName = body.branch.trim();
  if (!branchName || /\s/.test(branchName) || branchName.startsWith('-') || !/^[\w.\-/]+$/.test(branchName)) {
    sendJson(res, 400, { ok: false, error: 'Invalid branch name' });
    return;
  }

  const gitRepo = await isGitRepo(session.cwd);
  if (!gitRepo) {
    sendJson(res, 400, { ok: false, error: `${session.cwd} is not a git repository` });
    return;
  }

  try {
    const repoName = await getRepoName(session.cwd);
    const worktreeDir = resolve(deps.config.worktreesDir, `${repoName}_${branchName}`);
    await mkdir(deps.config.worktreesDir, { recursive: true });
    await createWorktree(session.cwd, worktreeDir, branchName);

    const newTopicName = `${session.name}/${branchName}`;
    const rootSession = deps.stateManager.getRootSession(groupId, topicId);
    const iconOpts: Record<string, any> = {};
    if (rootSession?.iconCustomEmojiId) {
      iconOpts.icon_custom_emoji_id = rootSession.iconCustomEmojiId;
    } else if (rootSession?.iconColor != null) {
      iconOpts.icon_color = rootSession.iconColor;
    } else {
      iconOpts.icon_color = 0x6FB9F0;
    }
    const forumTopic = await deps.telegram.createForumTopic(groupId, newTopicName, iconOpts);

    const newTopicId = forumTopic.message_thread_id;
    deps.stateManager.getOrCreateSession(groupId, newTopicId, {
      name: newTopicName,
      cwd: worktreeDir,
    });
    deps.stateManager.setSessionIcon(groupId, newTopicId, forumTopic.icon_color, forumTopic.icon_custom_emoji_id);
    deps.stateManager.setSessionForkInfo(groupId, newTopicId, topicId, branchName);

    sendJson(res, 201, {
      ok: true,
      data: {
        topic_id: newTopicId,
        name: newTopicName,
        branch: branchName,
        cwd: worktreeDir,
        parent_topic_id: topicId,
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Fork failed: ${error.message}` });
  }
};
