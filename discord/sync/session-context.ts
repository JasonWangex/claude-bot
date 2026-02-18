/**
 * Session Context 解析工具
 *
 * 根据 channelId 查找关联的 task/goal 和 cwd/git_branch 信息。
 * 纯同步 SQL 查询，用于在创建 ClaudeSession 时填充上下文。
 */

import type Database from 'better-sqlite3';
import { statSync } from 'fs';

export interface SessionContext {
  taskId: string | null;
  goalId: string | null;
  cwd: string | null;
  gitBranch: string | null;
}

const EMPTY_CONTEXT: SessionContext = {
  taskId: null,
  goalId: null,
  cwd: null,
  gitBranch: null,
};

/**
 * 根据 channelId 解析 session 的上下文信息
 *
 * 两条同步 SQL：
 * 1. 从 tasks 表查 task_id + goal_id（通过 channel_id 关联）
 * 2. 从 channels 表查 cwd + worktree_branch（PK 查询）
 */
export function resolveSessionContext(db: Database.Database, channelId?: string): SessionContext {
  if (!channelId) return EMPTY_CONTEXT;

  let taskId: string | null = null;
  let goalId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;

  try {
    // 查 task + goal（有 idx_tasks_channel 索引）
    const taskRow = db.prepare(
      'SELECT id, goal_id FROM tasks WHERE channel_id = ? LIMIT 1',
    ).get(channelId) as { id: string; goal_id: string | null } | undefined;

    if (taskRow) {
      taskId = taskRow.id;
      goalId = taskRow.goal_id;
    }

    // 查 cwd + git_branch（PK 查询）
    const channelRow = db.prepare(
      'SELECT cwd, worktree_branch FROM channels WHERE id = ?',
    ).get(channelId) as { cwd: string; worktree_branch: string | null } | undefined;

    if (channelRow) {
      cwd = channelRow.cwd;
      gitBranch = channelRow.worktree_branch;
    }
  } catch {
    // 表可能还不存在（migration 尚未运行），静默忽略
  }

  return { taskId, goalId, cwd, gitBranch };
}

/**
 * 将 Claude 项目目录名解码为真实文件系统路径
 *
 * Claude 编码规则: `/` → `-`, `.` → `-`（不可逆）。
 * 用贪心算法从左到右逐级验证目录是否存在来还原。
 *
 * 例: `-home-jason-projects-claude-bot` → `/home/jason/projects/claude-bot`
 *     `-Users-jason--claude-worktrees-X` → `/Users/jason/.claude-worktrees/X`
 *
 * 如果文件系统验证失败（路径不在本机），返回原始目录名。
 */
export function decodeProjectDirName(encoded: string): string {
  if (!encoded.startsWith('-')) return encoded;

  const parts = encoded.slice(1).split('-');
  let resolved = '/';
  let pending = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // '--' 表示原始路径中有 '.'（如 .claude → -claude，前面的 / 也是 -，合起来 --）
    if (part === '') {
      // 先提交 pending（需验证目录存在）
      if (pending) {
        try {
          if (statSync(resolved + pending).isDirectory()) {
            resolved += pending + '/';
            pending = '';
          }
        } catch {
          // 目录不存在，把 '--' 当作普通 '-' 拼接
          pending += '-';
          if (i + 1 < parts.length) {
            pending += parts[++i];
          }
          continue;
        }
      }
      // 下一段以 '.' 开头
      if (i + 1 < parts.length) {
        pending = '.' + parts[++i];
      }
      continue;
    }

    if (!pending) {
      pending = part;
    } else {
      // 尝试: resolved + pending 是否为有效目录？
      try {
        if (statSync(resolved + pending).isDirectory()) {
          resolved += pending + '/';
          pending = part;
          continue;
        }
      } catch {
        // 目录不存在，继续拼接
      }
      // 不是目录，用 `-` 拼接到 pending
      pending += '-' + part;
    }
  }

  const result = resolved + pending;

  // 验证：如果只走到了根目录 /（首个段就不存在），回退原始编码名
  if (resolved === '/') {
    return encoded;
  }
  return result;
}
