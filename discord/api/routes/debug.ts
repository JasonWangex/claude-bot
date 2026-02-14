/**
 * Debug API - 调试和监控端点
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { ApiDeps } from '../types.js';
import { sendJson } from '../middleware.js';
import { getDb } from '../../db/index.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * GET /api/debug/running-tasks
 * 检查所有 running 任务的实际执行状态
 */
export async function getRunningTasks(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: ApiDeps
): Promise<void> {
  const db = getDb();

  // 查询所有 running 状态的 tasks
  const runningTasks = db.prepare(`
    SELECT
      t.id, t.goal_id, t.description, t.status, t.pipeline_phase,
      t.channel_id, t.dispatched_at,
      g.seq as goal_seq, g.name as goal_name, g.drive_status
    FROM tasks t
    JOIN goals g ON t.goal_id = g.id
    WHERE t.status = 'running'
    ORDER BY t.dispatched_at DESC
  `).all();

  // 获取 Executor 的活跃进程信息
  const executor = (deps.claudeClient as any).executor;
  if (!executor) {
    sendJson(res, 200, {
      runningTasks: runningTasks.length,
      tasks: runningTasks,
      activeProcesses: [],
      warning: 'Executor not accessible'
    });
    return;
  }

  // 检查每个 task 的锁和进程状态
  const tasksWithStatus = runningTasks.map((task: any) => {
    const lockKey = task.channel_id
      ? `${task.goal_id?.substring(0, 8)}:${task.channel_id}`
      : 'unknown';

    const isRunning = executor.isRunning(lockKey);
    const queueLength = executor.getQueueLength(lockKey);

    return {
      ...task,
      lockKey,
      hasActiveProcess: isRunning,
      queueLength,
      runtimeMinutes: task.dispatched_at
        ? Math.floor((Date.now() - task.dispatched_at) / 1000 / 60)
        : 0,
      isZombie: !isRunning, // 状态 running 但无活跃进程
    };
  });

  // 统计
  const zombieTasks = tasksWithStatus.filter((t: any) => t.isZombie);

  sendJson(res, 200, {
    runningTasks: runningTasks.length,
    zombieTasks: zombieTasks.length,
    tasks: tasksWithStatus,
    summary: {
      total: runningTasks.length,
      withActiveProcess: runningTasks.length - zombieTasks.length,
      zombies: zombieTasks.length,
    },
  });
}

/**
 * GET /api/debug/active-processes
 * 查看所有活跃的 Claude 进程
 */
export async function getActiveProcesses(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: ApiDeps
): Promise<void> {
  const executor = (deps.claudeClient as any).executor;
  if (!executor) {
    sendJson(res, 500, { error: 'Executor not accessible' });
    return;
  }

  // 读取 process registry（如果存在）
  const registryFile = join(process.cwd(), 'data/active-processes.json');
  let registry: any[] = [];
  if (existsSync(registryFile)) {
    try {
      registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
      // 检查每个进程是否存活
      registry = registry.map(proc => ({
        ...proc,
        isAlive: isProcessAlive(proc.pid),
      }));
    } catch (e) {
      // ignore
    }
  }

  sendJson(res, 200, {
    activeProcesses: registry.length,
    processes: registry,
  });
}

/**
 * POST /api/debug/kill-zombie-tasks
 * 清理僵尸任务（状态 running 但无活跃进程）
 */
export async function killZombieTasks(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: ApiDeps
): Promise<void> {
  const db = getDb();
  const executor = (deps.claudeClient as any).executor;

  // 查询所有 running 任务
  const runningTasks = db.prepare(`
    SELECT id, goal_id, channel_id
    FROM tasks
    WHERE status = 'running'
  `).all() as any[];

  const zombies: string[] = [];
  for (const task of runningTasks) {
    const lockKey = task.channel_id
      ? `${task.goal_id?.substring(0, 8)}:${task.channel_id}`
      : 'unknown';

    const isRunning = executor?.isRunning(lockKey);
    if (!isRunning) {
      // 标记为 failed
      db.prepare(`
        UPDATE tasks
        SET status = 'failed',
            error = 'Zombie task: no active Claude process',
            completed_at = ?
        WHERE id = ? AND goal_id = ?
      `).run(Date.now(), task.id, task.goal_id);

      zombies.push(`${task.goal_id}/${task.id}`);
    }
  }

  sendJson(res, 200, {
    cleaned: zombies.length,
    tasks: zombies,
  });
}

// Helper function
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
