/**
 * Projects API 路由
 *
 * GET  /api/projects          — 列出所有项目（先同步文件系统到 DB，只返回 FS 存在的项目）
 * GET  /api/projects/:name    — 获取单个项目详情
 * POST /api/projects/sync     — 显式同步：扫描文件系统 + 为无 Discord 绑定的项目创建 category/channel
 */

import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { ChannelType } from 'discord.js';
import type { RouteHandler, ProjectSyncResult } from '../types.js';
import { sendJson, requireAuth } from '../middleware.js';
import { getAuthorizedGuildId } from '../../utils/env.js';
import { ProjectRepository } from '../../db/project-repo.js';
import type { Project } from '../../types/repository.js';

// 防止并发 sync 请求重复创建 Discord channel
let syncInProgress = false;

/** 扫描文件系统，返回项目文件夹名列表 */
function scanProjectDirs(projectsRoot: string, worktreesDir: string): string[] {
  const resolvedWorktrees = resolve(worktreesDir);
  try {
    return readdirSync(projectsRoot)
      .filter(name => {
        const fullPath = join(projectsRoot, name);
        try {
          if (!statSync(fullPath).isDirectory()) return false;
          if (resolve(fullPath) === resolvedWorktrees) return false;
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * 将文件系统目录同步到 projects 表，返回合并后的 existingMap 供调用方复用。
 *
 * - 一次性加载所有现有记录，减少 DB 往返
 * - 只对以下情况执行 upsert：(a) 新目录 (b) guildId 发生变化
 *   这样 updated_at 仅在数据实际变化时才更新，保持字段的审计语义
 * - 不删除孤立记录（孤立项目在返回时由调用方过滤）
 */
async function syncFsToDB(
  repo: ProjectRepository,
  dirs: string[],
  guildId: string | null,
): Promise<Map<string, Project>> {
  const now = Date.now();
  const existingAll = await repo.getAll();
  const existingMap = new Map(existingAll.map(p => [p.name, p]));

  for (const name of dirs) {
    const existing = existingMap.get(name);
    const incomingGuildId = guildId ?? existing?.guildId ?? null;

    // 只在新项目或 guildId 变更时才写 DB（保持 updated_at 语义）
    if (!existing || incomingGuildId !== existing.guildId) {
      const project: Project = {
        name,
        guildId: incomingGuildId,
        categoryId: existing?.categoryId ?? null,
        channelId: existing?.channelId ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await repo.upsert(project);
      existingMap.set(name, project);
    }
  }

  return existingMap;
}

/** Project 实体 → API 响应格式（含完整磁盘路径） */
function projectToResponse(p: Project, projectsRoot: string) {
  return {
    name: p.name,
    full_path: `${projectsRoot}/${p.name}`,
    guild_id: p.guildId,
    category_id: p.categoryId,
    channel_id: p.channelId,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

// GET /api/projects
export const listProjects: RouteHandler = async (_req, res, _params, deps) => {
  try {
    const { projectsRoot, worktreesDir } = deps.config;
    // 统一使用运行时动态 guildId（与 requireAuth 来源一致）
    const guildId = getAuthorizedGuildId() ?? deps.config.authorizedGuildId ?? null;

    const dirs = scanProjectDirs(projectsRoot, worktreesDir);
    const repo = new ProjectRepository(deps.db);

    // 自动同步 + 拿回合并后的 Map，无需再次 getAll()
    const existingMap = await syncFsToDB(repo, dirs, guildId);

    // 只返回 FS 中当前存在的项目（过滤掉 DB 中的孤立记录）
    const dirSet = new Set(dirs);
    const projects = [...existingMap.values()].filter(p => dirSet.has(p.name));

    sendJson(res, 200, { ok: true, data: projects.map(p => projectToResponse(p, projectsRoot)) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to list projects: ${error.message}` });
  }
};

// GET /api/projects/:name
export const getProject: RouteHandler = async (_req, res, params, deps) => {
  // 防御性校验：拒绝路径遍历字符和空字节
  if (!params.name || params.name === '..' || params.name === '.' || params.name.includes('\0')) {
    sendJson(res, 400, { ok: false, error: 'Invalid project name' });
    return;
  }

  try {
    const repo = new ProjectRepository(deps.db);
    const project = await repo.get(params.name);
    if (!project) {
      sendJson(res, 404, { ok: false, error: `Project not found: ${params.name}` });
      return;
    }
    sendJson(res, 200, { ok: true, data: projectToResponse(project, deps.config.projectsRoot) });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `Failed to get project: ${error.message}` });
  }
};

// POST /api/projects/sync
// 扫描文件系统 → upsert DB → 为缺少 Discord 绑定的项目创建 category + default channel
export const syncProjects: RouteHandler = async (_req, res, _params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  // 防止并发 sync 请求导致重复创建 Discord channel
  if (syncInProgress) {
    sendJson(res, 409, { ok: false, error: 'Sync already in progress, please try again later' });
    return;
  }
  syncInProgress = true;

  try {
    const { projectsRoot, worktreesDir } = deps.config;
    const dirs = scanProjectDirs(projectsRoot, worktreesDir);
    const repo = new ProjectRepository(deps.db);

    // 1. 同步文件系统 → DB，复用返回的 Map（避免重复 getAll）
    const existingMap = await syncFsToDB(repo, dirs, guildId);
    const dirSet = new Set(dirs);
    const projects = [...existingMap.values()].filter(p => dirSet.has(p.name));

    // 2. 为缺少 Discord 绑定的项目创建 category + default channel
    const guild = await deps.client.guilds.fetch(guildId);
    const results: ProjectSyncResult[] = [];

    for (const project of projects) {
      // 两者都有绑定 → 跳过
      if (project.categoryId && project.channelId) {
        results.push({
          name: project.name,
          created: false,
          category_id: project.categoryId,
          channel_id: project.channelId,
        });
        continue;
      }

      try {
        // 如果已有 categoryId（半完成状态），跳过 category 创建直接续建 channel
        let categoryId = project.categoryId;
        if (!categoryId) {
          const category = await guild.channels.create({
            name: project.name,
            type: ChannelType.GuildCategory,
          });
          categoryId = category.id;
          // 立即写 DB，防止后续 channel 创建失败时 categoryId 丢失
          await repo.upsert({ ...project, guildId, categoryId, updatedAt: Date.now() });
        }

        const channel = await guild.channels.create({
          name: 'general',
          type: ChannelType.GuildText,
          parent: categoryId,
        });

        await repo.upsert({
          ...project,
          guildId,
          categoryId,
          channelId: channel.id,
          updatedAt: Date.now(),
        });

        results.push({
          name: project.name,
          created: true,
          category_id: categoryId,
          channel_id: channel.id,
        });
      } catch (err: any) {
        // 记录失败，继续处理其他项目，不丢弃已成功的结果
        results.push({
          name: project.name,
          created: false,
          category_id: project.categoryId,
          channel_id: project.channelId,
          error: err.message,
        });
      }
    }

    sendJson(res, 200, { ok: true, data: results });
  } finally {
    syncInProgress = false;
  }
};
