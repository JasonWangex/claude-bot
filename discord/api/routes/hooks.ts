/**
 * Hook API - 接收来自 Claude Code hooks 的事件通知
 *
 * 处理 Claude CLI hooks 发送的生命周期事件：
 * - SessionStart: session 开始执行
 * - Notification: Claude 等待用户输入
 * - Stop: 当前轮次完成
 * - SessionEnd: session 结束
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { ApiDeps } from '../types.js';
import { sendJson, readJsonBody } from '../middleware.js';
import { logger } from '../../utils/logger.js';
import { EmbedColors } from '../../bot/message-queue.js';

// Session 级别的并发锁（防止并发 Hook 事件导致状态覆盖）
const sessionLocks = new Map<string, Promise<void>>();

/**
 * POST /api/internal/hooks/session-event
 * 接收 Claude Code hooks 发送的 session 事件
 *
 * 输入格式（来自 Claude Code hooks）：
 * {
 *   "session_id": "abc-123",
 *   "transcript_path": "/path/to/transcript.jsonl",
 *   "cwd": "/path/to/project",
 *   "permission_mode": "default" | "bypassPermissions",
 *   "hook_event_name": "Stop" | "SessionEnd" | "SessionStart" | "Notification",
 *   "reason": "clear" | "logout" | "prompt_input_exit" | "other", // 仅 SessionEnd
 *   "metadata": { ... } // 可选，Stop 事件包含 token/cost 数据
 * }
 */
export async function handleSessionEvent(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: ApiDeps
): Promise<void> {
  try {
    const payload = await readJsonBody(req);
    const { hook_event_name, session_id, reason, metadata } = payload;

    if (!session_id) {
      sendJson(res, 400, { ok: false, error: 'session_id required' });
      return;
    }

    // 记录收到的 hook 事件
    logger.info('Received hook event:', {
      hook_event_name,
      session_id: session_id?.slice(0, 8),
      reason,
      cwd: payload.cwd,
    });

    // 并发保护：等待前一个 hook 事件处理完成
    const existingLock = sessionLocks.get(session_id);
    if (existingLock) {
      await existingLock;
    }

    // 创建新锁并处理事件
    const currentLock = handleSessionEventLocked(session_id, payload, deps);
    sessionLocks.set(session_id, currentLock);

    try {
      await currentLock;
      sendJson(res, 200, {
        ok: true,
        message: 'Hook event processed',
        event: hook_event_name,
      });
    } finally {
      sessionLocks.delete(session_id);
    }
  } catch (error: any) {
    logger.error('Failed to handle hook event:', error);
    sendJson(res, 500, {
      ok: false,
      error: error.message,
    });
  }
}

/**
 * 实际处理 hook 事件（带锁保护）
 */
async function handleSessionEventLocked(
  session_id: string,
  payload: any,
  deps: ApiDeps
): Promise<void> {
  const { hook_event_name, reason, metadata } = payload;

  const claudeSessionRepo = deps.stateManager['claudeSessionRepo'];
  if (!claudeSessionRepo) {
    logger.warn('[Hook] ClaudeSessionRepo not available, skipping event processing');
    return;
  }

  const session = await claudeSessionRepo.findByClaudeSessionId(session_id);
  if (!session) {
    logger.warn(`[Hook] Session not found for claude_session_id: ${session_id}`);
    return;
  }

  const channelId = session.channelId;
  if (!channelId) {
    logger.warn(`[Hook] Session ${session.id} has no channelId, skipping`);
    return;
  }

    // 2. 根据 hook_event_name 处理
  switch (hook_event_name) {
    case 'SessionStart':
      await handleSessionStart(session, deps);
      break;

    case 'Notification':
      await handleNotification(session, channelId, deps);
      break;

    case 'Stop':
      await handleStop(session, channelId, metadata, deps);
      break;

    case 'SessionEnd':
      await handleSessionEnd(session, channelId, reason, deps);
      break;

    default:
      logger.debug(`[Hook] Unhandled event: ${hook_event_name}`);
  }
}

/**
 * SessionStart - Claude 开始执行
 */
async function handleSessionStart(
  session: any,
  deps: ApiDeps
): Promise<void> {
  const claudeSessionRepo = deps.stateManager['claudeSessionRepo'];
  if (!claudeSessionRepo) return;

  const now = Date.now();
  session.status = 'active';
  session.lastActivityAt = now;
  await claudeSessionRepo.save(session);

  logger.debug(`[Hook] SessionStart: ${session.id} → active`);
}

/**
 * Notification - Claude 等待用户输入
 * 延迟 5 秒发送等待消息（可能被后续交互取消）
 */
async function handleNotification(
  session: any,
  channelId: string,
  deps: ApiDeps
): Promise<void> {
  const claudeSessionRepo = deps.stateManager['claudeSessionRepo'];
  if (!claudeSessionRepo) return;

  const now = Date.now();
  session.status = 'waiting';
  session.lastActivityAt = now;
  await claudeSessionRepo.save(session);

  logger.debug(`[Hook] Notification: ${session.id} → waiting`);

  // 延迟 5 秒发送等待消息
  const timer = setTimeout(async () => {
    try {
      // 双重检查：确保仍在 waiting 且定时器未被取消
      const tracking = deps.stateManager['sessionTracking']?.get(channelId);
      if (!tracking || tracking.waitingTimer !== timer) {
        logger.debug('[Hook] Waiting message cancelled by user interaction');
        return;
      }

      // 检查是否仍在 waiting 状态
      const latestSession = await claudeSessionRepo.get(session.id);
      if (latestSession?.status === 'waiting') {
        // 计算 token 使用率
        let usageText = '';
        if (latestSession.lastUsageJson) {
          try {
            const usage = JSON.parse(latestSession.lastUsageJson);
            const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
            const cacheTokens = (usage.cache_read_input_tokens || 0);
            const contextWindow = 200000; // 默认上下文窗口
            const percentage = ((totalTokens / contextWindow) * 100).toFixed(1);
            usageText = `(${totalTokens.toLocaleString()} tokens, ${percentage}%)`;
          } catch (err) {
            logger.warn('[Hook] Failed to parse lastUsageJson:', err);
          }
        }

        const msgId = await deps.mq.send(
          channelId,
          `@everyone 等待输入 ${usageText}`,
          { priority: 'high', embedColor: EmbedColors.BLUE }
        );

        // 记录消息 ID 用于后续删除
        deps.stateManager.setWaitingMessageId(channelId, msgId);
      }
    } catch (err) {
      logger.error('[Hook] Failed to send waiting message:', err);
    }
  }, 5000);

  // 保存定时器以便取消
  deps.stateManager.setWaitingTimer(channelId, timer);
}

/**
 * Stop - 当前轮次完成
 * - 幂等发送完成消息（10秒窗口）
 * - 触发 Goal task 检查（仅 goalId 存在时）
 */
async function handleStop(
  session: any,
  channelId: string,
  metadata: any,
  deps: ApiDeps
): Promise<void> {
  const claudeSessionRepo = deps.stateManager['claudeSessionRepo'];
  if (!claudeSessionRepo) return;

  const now = Date.now();

  // 幂等检查：10秒内不重复发送（从数据库读取）
  const lastStopTime = session.lastStopAt;
  if (lastStopTime && (now - lastStopTime) < 10000) {
    logger.debug('[Hook] Skip duplicate Stop message (within 10s window)');
    return;
  }

  // 更新 session 状态
  session.status = 'idle';
  session.lastActivityAt = now;
  session.lastStopAt = now;  // 持久化 Stop 时间

  // 保存 usage 数据
  if (metadata) {
    session.lastUsageJson = JSON.stringify(metadata);
  }

  await claudeSessionRepo.save(session);

  logger.debug(`[Hook] Stop: ${session.id} → idle`);

  // 取消待发的等待消息
  const waitingMsgId = deps.stateManager.getWaitingMessageId(channelId);
  if (waitingMsgId) {
    try {
      await deps.mq.delete(channelId, waitingMsgId);
      deps.stateManager.cancelWaitingMessage(channelId);
    } catch (err) {
      logger.warn('[Hook] Failed to delete waiting message:', err);
    }
  }

  // 计算执行时长和 token 信息
  let durationText = '';
  let tokenText = '';
  let costText = '';

  if (metadata) {
    const { duration_ms, input_tokens, output_tokens, cache_read_input_tokens, total_cost_usd } = metadata;

    if (duration_ms) {
      const seconds = Math.round(duration_ms / 1000);
      durationText = `${seconds}秒`;
    }

    if (input_tokens || output_tokens) {
      const total = (input_tokens || 0) + (output_tokens || 0);
      const cached = cache_read_input_tokens || 0;
      const contextWindow = 200000; // 默认上下文窗口
      const percentage = ((total / contextWindow) * 100).toFixed(1);
      tokenText = `${total.toLocaleString()} tokens (${percentage}%)`;

      if (cached > 0) {
        tokenText += ` [缓存: ${cached.toLocaleString()}]`;
      }
    }

    if (total_cost_usd) {
      costText = `$${total_cost_usd.toFixed(4)}`;
    }
  }

  // 发送完成消息
  const parts = ['@everyone Done'];
  if (durationText) parts.push(durationText);
  if (tokenText) parts.push(tokenText);
  if (costText) parts.push(costText);

  await deps.mq.send(
    channelId,
    parts.join(' | '),
    { priority: 'high', embedColor: EmbedColors.GREEN }
  );

  // 触发 Goal task 检查（仅 goalId 存在时）
  if (deps.orchestrator) {
    await checkGoalTaskCompletion(session, channelId, deps);
  }
}

/**
 * SessionEnd - Session 结束
 * - reason=other 表示异常退出，标记任务失败
 */
async function handleSessionEnd(
  session: any,
  channelId: string,
  reason: string | undefined,
  deps: ApiDeps
): Promise<void> {
  const claudeSessionRepo = deps.stateManager['claudeSessionRepo'];
  if (!claudeSessionRepo) return;

  session.status = 'closed';
  session.closedAt = Date.now();
  await claudeSessionRepo.save(session);

  logger.debug(`[Hook] SessionEnd: ${session.id} → closed (reason: ${reason})`);

  // 清除追踪状态
  deps.stateManager.clearSessionTracking(channelId);

  // 异常退出处理
  if (reason === 'other' && deps.orchestrator) {
    const taskRepo = (deps.orchestrator as any).deps?.taskRepo;
    if (!taskRepo) return;

    try {
      const tasks = await taskRepo.findByChannelId(channelId);
      for (const task of tasks.filter((t: any) => t.status === 'running')) {
        logger.warn(`[Hook] Marking task ${task.id} as failed due to session termination`);
        await deps.orchestrator.onTaskFailed(
          task.goalId,
          task.id,
          'Session terminated unexpectedly'
        );
      }
    } catch (err) {
      logger.error('[Hook] Failed to handle session termination:', err);
    }
  }
}

/**
 * 检查 Goal task 完成状态
 * - 仅对关联 Goal 的任务触发
 * - 向 Claude 发送 3 问检查
 */
async function checkGoalTaskCompletion(
  session: any,
  channelId: string,
  deps: ApiDeps
): Promise<void> {
  if (!deps.orchestrator) return;

  const taskRepo = (deps.orchestrator as any).deps?.taskRepo;
  if (!taskRepo) return;

  try {
    const tasks = await taskRepo.findByChannelId(channelId);
    const runningTask = tasks.find((t: any) => t.status === 'running' && t.goalId);

    if (!runningTask) {
      logger.debug('[Hook] No running goal task found, skip completion check');
      return;
    }

    // 调用 orchestrator 进行任务完成检查
    await deps.orchestrator.checkTaskReadiness(runningTask.goalId, runningTask.id, channelId);

    logger.debug(`[Hook] Triggered task completion check for task ${runningTask.id}`);
  } catch (err) {
    logger.error('[Hook] Failed to check task completion:', err);
  }
}
