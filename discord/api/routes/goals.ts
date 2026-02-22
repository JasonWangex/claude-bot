/**
 * Goal Drive API 路由
 *
 * POST /api/goals/:goalId/drive   — 启动 Goal drive
 * GET  /api/goals/:goalId/status  — 查看 drive 状态
 * POST /api/goals/:goalId/pause   — 暂停
 * POST /api/goals/:goalId/resume  — 恢复
 * POST /api/goals/:goalId/tasks/:taskId/skip    — 跳过子任务
 * POST /api/goals/:goalId/tasks/:taskId/done    — 标记手动任务完成
 * POST /api/goals/:goalId/tasks/:taskId/retry   — 重试失败/blocked/paused 任务
 * POST /api/goals/:goalId/tasks/:taskId/pause   — 暂停运行中的任务
 * POST /api/goals/:goalId/tasks/:taskId/resume  — 恢复暂停的任务
 * POST /api/goals/:goalId/rollback               — 发起回滚评估（需 body.checkpointId）
 * POST /api/goals/:goalId/confirm-rollback        — 确认执行回滚
 * POST /api/goals/:goalId/cancel-rollback         — 取消回滚
 */

import { stat } from 'fs/promises';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { logger } from '../../utils/logger.js';
import type { StartDriveParams } from '../../orchestrator/index.js';

// POST /api/goals/:goalId/drive
export const startDrive: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const goalId = params.goalId;

  const body = await readJsonBody<Omit<StartDriveParams, 'goalId'>>(req);
  if (!body?.goalName || !body?.goalChannelId || !body?.baseCwd) {
    sendJson(res, 400, {
      ok: false,
      error: 'Required: goalName, goalChannelId, baseCwd',
    });
    return;
  }

  try {
    const s = await stat(body.baseCwd);
    if (!s.isDirectory()) {
      sendJson(res, 400, { ok: false, error: `baseCwd is not a directory: ${body.baseCwd}` });
      return;
    }
  } catch {
    sendJson(res, 400, { ok: false, error: `baseCwd does not exist: ${body.baseCwd}` });
    return;
  }

  try {
    const state = await deps.orchestrator.startDrive({
      goalId,
      goalName: body.goalName,
      goalChannelId: body.goalChannelId,
      baseCwd: body.baseCwd,
      maxConcurrent: body.maxConcurrent,
    });

    sendJson(res, 200, { ok: true, data: state });
  } catch (err: any) {
    logger.error(`[API] startDrive failed:`, err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// GET /api/goals/:goalId/status
export const getDriveStatus: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const state = await deps.orchestrator.getStatus(params.goalId);
  if (!state) {
    sendJson(res, 404, { ok: false, error: 'No drive found for this goal' });
    return;
  }

  sendJson(res, 200, { ok: true, data: state });
};

// POST /api/goals/:goalId/pause
export const pauseDrive: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.pauseDrive(params.goalId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Drive not running or not found' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'paused' } });
};

// POST /api/goals/:goalId/resume
export const resumeDrive: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.resumeDrive(params.goalId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Drive not paused or not found' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'running' } });
};

// POST /api/goals/:goalId/tasks/:taskId/skip
export const skipTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.skipTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or cannot be skipped' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'skipped' } });
};

// POST /api/goals/:goalId/tasks/:taskId/done
export const markTaskDone: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.markTaskDone(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not blocked' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'completed' } });
};

// POST /api/goals/:goalId/tasks/:taskId/retry
export const retryTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.retryTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not in retryable state (failed/blocked_feedback/paused)' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'pending' } });
};

// POST /api/goals/:goalId/tasks/:taskId/refix
export const refixTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.refixTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not in refixable state (must be failed with existing context)' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'running' } });
};

// POST /api/goals/:goalId/tasks/:taskId/pause
export const pauseTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.pauseTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not running' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'paused' } });
};

// POST /api/goals/:goalId/tasks/:taskId/resume
export const resumeTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.resumeTask(params.goalId, params.taskId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'Task not found or not paused' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'running' } });
};

// POST /api/goals/:goalId/tasks/:taskId/nudge
export const nudgeTask: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const result = await deps.orchestrator.nudgeTask(params.goalId, params.taskId);
  if (!result.ok) {
    sendJson(res, 400, { ok: false, error: result.message });
    return;
  }

  sendJson(res, 200, { ok: true, data: { message: result.message } });
};

// POST /api/goals/:goalId/rollback
export const rollback: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const body = await readJsonBody<{ checkpointId: string }>(req);
  if (!body?.checkpointId) {
    sendJson(res, 400, { ok: false, error: 'Required: checkpointId' });
    return;
  }

  try {
    const pending = await deps.orchestrator.rollback(params.goalId, body.checkpointId);
    if (!pending) {
      sendJson(res, 400, { ok: false, error: 'Rollback failed — check goal thread for details' });
      return;
    }

    sendJson(res, 200, { ok: true, data: pending });
  } catch (err: any) {
    logger.error(`[API] rollback failed:`, err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// POST /api/goals/:goalId/confirm-rollback
export const confirmRollback: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  try {
    const ok = await deps.orchestrator.confirmRollback(params.goalId);
    if (!ok) {
      sendJson(res, 400, { ok: false, error: 'No pending rollback or rollback failed' });
      return;
    }

    sendJson(res, 200, { ok: true, data: { status: 'rolled_back' } });
  } catch (err: any) {
    logger.error(`[API] confirmRollback failed:`, err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
};

// POST /api/goals/:goalId/cancel-rollback
export const cancelRollback: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  if (!deps.orchestrator) {
    sendJson(res, 503, { ok: false, error: 'Orchestrator not available' });
    return;
  }

  const ok = await deps.orchestrator.cancelRollback(params.goalId);
  if (!ok) {
    sendJson(res, 400, { ok: false, error: 'No pending rollback' });
    return;
  }

  sendJson(res, 200, { ok: true, data: { status: 'cancelled' } });
};
