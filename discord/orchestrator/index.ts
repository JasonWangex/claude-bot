/**
 * GoalOrchestrator — Goal 自动调度引擎（Discord 版）
 *
 * 负责：
 * 1. 启动 Goal drive（创建 goal 分支 + Category Text Channel）
 * 2. 自动派发子任务到独立 worktree/Text Channel
 * 3. 监控子任务完成 → 自动 merge 到 goal 分支
 * 4. 全程通知用户，异常时暂停等待干预
 */

import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import { type MessageQueue, EmbedColors, type EmbedColor } from '../bot/message-queue.js';
import type { DiscordBotConfig, GoalDriveState, GoalTask, GoalTaskFeedback, GoalPipelinePhase, PendingRollback, ChatUsageResult } from '../types/index.js';
import type { IGoalRepo } from '../types/repository.js';
import { stat, readFile, access } from 'fs/promises';
import { join } from 'path';
import { getAuthorizedGuildId, getGoalLogChannelId } from '../utils/env.js';
import { generateTopicTitle } from '../utils/llm.js';
import { execGit, resolveMainWorktree } from './git-ops.js';
import { parseTasks, goalNameToBranch, translateToBranchName } from './goal-state.js';
import { getNextBatch, isGoalComplete, isGoalStuck, getProgressSummary } from './task-scheduler.js';
import { parseTaskDetailPlans, formatDetailPlanForPrompt } from './goal-body-parser.js';
import {
  createGoalBranch,
  createSubtaskBranch,
  mergeSubtaskBranch,
  cleanupSubtask,
  hasUncommittedChanges,
  autoCommit,
} from './goal-branch.js';
import { resolveConflictsWithAI } from './conflict-resolver.js';
import { logger } from '../utils/logger.js';
import {
  replanTasks,
  collectCompletedDiffStats,
  handleReplanByImpact,
  applyChanges,
  updateGoalBodyWithTasks,
  type ReplanContext,
  type ReplanChange,
  type ReplanResult,
} from './replanner.js';
import {
  buildReplanApprovalButtons,
  buildReplanRollbackButton,
  buildRollbackConfirmButtons,
  buildTaskFailedButtons,
  buildFailureButtons,
} from './goal-buttons.js';
import type { IGoalMetaRepo, ITaskRepo, IGoalCheckpointRepo } from '../types/repository.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';

interface OrchestratorDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  messageHandler: MessageHandler;
  client: Client;
  mq: MessageQueue;
  config: DiscordBotConfig;
  goalRepo: IGoalRepo;
  goalMetaRepo: IGoalMetaRepo;
  taskRepo: ITaskRepo;
  checkpointRepo: IGoalCheckpointRepo;
  promptService: PromptConfigService;
}

/** startDrive 的入参 */
export interface StartDriveParams {
  goalId: string;
  goalName: string;
  goalChannelId: string;
  baseCwd: string;
  tasks: Array<{
    id: string;
    description: string;
    type?: string;
    depends?: string[];
    phase?: number;
    complexity?: string;
  }>;
  maxConcurrent?: number;
}

export class GoalOrchestrator {
  private deps: OrchestratorDeps;
  private mergeLocks = new Map<string, Promise<void>>();
  private stateLocks = new Map<string, Promise<void>>();
  private activeDrives = new Map<string, GoalDriveState>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** 生成带 goal seq 前缀的任务标签，如 g2t1 */
  private getTaskLabel(state: GoalDriveState, taskId: string): string {
    return state.goalSeq > 0 ? `g${state.goalSeq}${taskId}` : taskId;
  }

  /**
   * 串行化对同一 goal 的状态操作，防止并发 read-modify-write race condition
   */
  private async withStateLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.stateLocks.get(goalId) ?? Promise.resolve();
    let resolve: () => void;
    const current = new Promise<void>(r => { resolve = r; });
    this.stateLocks.set(goalId, current);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  /** 同步 Goal 元数据 status（GoalMetaRepo 管理的 status 字段） */
  private async syncGoalMetaStatus(goalId: string, status: string): Promise<void> {
    try {
      const meta = await this.deps.goalMetaRepo.get(goalId);
      if (meta) {
        meta.status = status as any;
        await this.deps.goalMetaRepo.save(meta);
      }
    } catch (err: any) {
      logger.warn(`[Orchestrator] Failed to sync goal meta status: ${err.message}`);
    }
  }

  /** 启动 Goal 自动推进 */
  async startDrive(params: StartDriveParams): Promise<GoalDriveState> {
    const { goalId, goalName, goalChannelId, baseCwd: inputCwd, tasks: rawTasks, maxConcurrent = 3 } = params;

    const existing = this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
    if (existing && (existing.status === 'running' || existing.status === 'paused')) {
      const hint = existing.status === 'paused' ? ' Use resumeDrive to continue.' : '';
      await this.notify(goalChannelId, `Goal "${goalName}" is already ${existing.status}.${hint}`, 'info');
      return existing;
    }

    let baseCwd: string;
    try {
      baseCwd = await resolveMainWorktree(inputCwd);
      if (baseCwd !== inputCwd) {
        logger.info(`[Orchestrator] Normalized baseCwd: ${inputCwd} → ${baseCwd}`);
      }
    } catch (err: any) {
      await this.notify(goalChannelId, `Invalid working directory: ${inputCwd}\nError: ${err.message}`, 'error');
      throw err;
    }

    const goalBranch = await goalNameToBranch(goalName);

    let goalWorktreeDir: string;
    try {
      goalWorktreeDir = await createGoalBranch(baseCwd, goalBranch, this.deps.config.worktreesDir);
    } catch (err: any) {
      await this.notify(goalChannelId, `Failed to create goal branch: ${err.message}`, 'error');
      throw err;
    }

    // 获取 goalMeta（seq + body），全方法共用
    const goalMeta = await this.deps.goalMetaRepo.get(goalId);
    const goalSeq = goalMeta?.seq ?? 0;

    const state: GoalDriveState = {
      goalId,
      goalSeq,
      goalName,
      goalBranch,
      goalChannelId,
      baseCwd,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxConcurrent,
      tasks: parseTasks(rawTasks),
    };

    // 从 Goal body 解析详细计划，一次性附加到 task 上
    if (goalMeta?.body) {
      const plans = parseTaskDetailPlans(goalMeta.body);
      for (const task of state.tasks) {
        const plan = plans.get(task.id);
        if (plan) {
          task.detailPlan = formatDetailPlanForPrompt(plan);
        }
      }
    }

    await this.saveState(state);
    this.activeDrives.set(goalId, state);
    await this.syncGoalMetaStatus(goalId, 'Processing');

    await this.notify(goalChannelId,
      `**Goal Drive started:** ${goalName}\n` +
      `Branch: \`${goalBranch}\`\n` +
      `Tasks: ${state.tasks.length}\n` +
      `Max concurrent: ${maxConcurrent}`,
      'success'
    );

    // 创建 Brain（持久化 Opus 战略大脑）
    await this.createBrain(state, goalMeta);

    await this.reviewAndDispatch(state);
    return state;
  }

  async pauseDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'running') return false;
    state.status = 'paused';
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Goal "${state.goalName}" paused`, 'warning');
    return true;
  }

  async resumeDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'paused') return false;
    state.status = 'running';
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Goal "${state.goalName}" resumed`, 'success');
    await this.reviewAndDispatch(state);
    return true;
  }

  async getStatus(goalId: string): Promise<GoalDriveState | null> {
    return await this.getState(goalId);
  }

  async skipTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    if (task.status !== 'pending' && task.status !== 'blocked' && task.status !== 'failed' && task.status !== 'paused') return false;

    // paused 任务可能有关联的进程，先清理
    if (task.status === 'paused' && task.channelId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'skipped';
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Skipped task: ${this.getTaskLabel(state, task.id)} - ${task.description}`, 'info');
    if (state.status === 'running') await this.reviewAndDispatch(state);
    return true;
  }

  async markTaskDone(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'blocked') return false;
    task.status = 'completed';
    task.completedAt = Date.now();
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Manual task completed: ${this.getTaskLabel(state, task.id)} - ${task.description}`, 'success');
    if (state.status === 'running') await this.reviewAndDispatch(state, taskId);
    return true;
  }

  async retryTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    if (task.status !== 'failed' && task.status !== 'blocked_feedback' && task.status !== 'paused') return false;

    // paused 任务可能还有运行中的进程（理论上不会，但防御性处理）
    if (task.status === 'paused' && task.channelId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'pending';
    task.error = undefined;
    task.branchName = undefined;
    task.channelId = undefined;
    task.dispatchedAt = undefined;
    task.merged = false;
    task.feedback = undefined;
    task.pipelinePhase = undefined;
    task.auditRetries = 0;
    task.tokensIn = undefined;
    task.tokensOut = undefined;
    task.cacheReadIn = undefined;
    task.cacheWriteIn = undefined;
    task.costUsd = undefined;
    task.durationMs = undefined;
    await this.saveState(state);
    await this.notify(state.goalChannelId, `Retrying task: ${this.getTaskLabel(state, task.id)} - ${task.description}`, 'warning');
    if (state.status === 'running') await this.reviewAndDispatch(state);
    return true;
  }

  /**
   * 轻量重试：保留 branch/thread 上下文，从 audit 阶段重新开始修复
   * 适用于 audit fix 耗尽但代码本身大部分完成的场景
   */
  async refixTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    // refix 只对 failed 且有 threadId 的任务有效（即有代码上下文）
    if (task.status !== 'failed' || !task.channelId) return false;

    const guildId = this.getGuildId();
    if (!guildId) return false;

    // 中止可能残留的进程
    const lockKey = StateManager.channelLockKey(guildId, task.channelId);
    this.deps.claudeClient.abort(lockKey);

    // 保留 branch/thread/dispatchedAt，只重置 fix 相关状态
    task.status = 'running';
    task.error = undefined;
    task.pipelinePhase = 'fix';
    task.auditRetries = 0;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
      `Refixing task: ${this.getTaskLabel(state, task.id)} - ${task.description}`,
      'warning',
    );

    // 直接触发 audit → fix 循环（不经过 reviewAndDispatch）
    this.startRefixPipeline(goalId, taskId, guildId, task.channelId, task, state);
    return true;
  }

  /**
   * 从失败任务触发重规划
   */
  async replanFromTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'failed') return false;

    await this.notify(state.goalChannelId,
      `Triggering replan from task ${this.getTaskLabel(state, task.id)}...`,
      'info',
    );

    // 跳过失败任务
    task.status = 'skipped';
    await this.saveState(state);

    await this.triggerReplan(state, taskId, {
      type: 'replan',
      reason: `User requested replan after task ${task.id} failed: ${task.error ?? 'unknown error'}`,
    });

    const refreshed = await this.getState(goalId);
    if (refreshed?.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
    return true;
  }

  /**
   * refix 流水线：在已有 thread 上重新 audit → fix 循环
   */
  private startRefixPipeline(
    goalId: string, taskId: string, guildId: string, channelId: string,
    task: GoalTask, state: GoalDriveState,
  ): void {
    (async () => {
      const usage = this.emptyUsage();
      try {
        // 初始化 usage 累积器
        const usage: ChatUsageResult = {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          total_cost_usd: 0,
          duration_ms: 0,
        };

        // 先跑一次 audit，拿到最新 issues
        const auditResult = await this.runAudit(goalId, taskId, guildId, channelId, task, state, usage);
        if (auditResult.verdict === 'pass') {
          await this.onTaskCompleted(goalId, taskId, usage);
          return;
        }
        // 进入标准 fix 循环
        await this.auditFixLoop(goalId, taskId, guildId, channelId, task, state, auditResult.summary, auditResult.issues, auditResult.verifyCommands, usage);
      } catch (err: any) {
        const stillRunning = await this.isTaskStillRunning(goalId, taskId);
        if (!stillRunning) return;
        try {
          await this.onTaskFailed(goalId, taskId, err.message, usage);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] startRefixPipeline onTaskFailed also failed:`, cbErr.message);
        }
      }
    })();
  }

  // ========== Feedback 智能调查 ==========

  /**
   * 启动 AI 调查 blocked/clarify feedback
   *
   * 流程：
   * 1. 在已有 thread 中发送调查 prompt（Sonnet 快速分析）
   * 2. Claude 分析 blocked 原因、检查依赖状态/代码上下文
   * 3. 写结论到 feedback/<taskId>-investigate.json
   * 4. 根据结论自动路由：continue（继续修复）/ retry / replan / escalate
   */
  private startFeedbackInvestigation(
    state: GoalDriveState,
    task: GoalTask,
    guildId: string,
  ): void {
    const goalId = state.goalId;
    const taskId = task.id;
    const channelId = task.channelId!;

    (async () => {
      try {
        // 使用 Sonnet 做调查（快速且够用）
        const { pipelineSonnetModel: sonnetModel } = this.deps.config;
        this.switchSessionModel(guildId, channelId, sonnetModel, 'fix');
        await this.updatePipelinePhase(goalId, taskId, 'fix');

        await this.notify(state.goalChannelId,
          `[Pipeline] ${taskId}: AI 调查 blocked feedback...`,
          'pipeline',
        );

        const prompt = this.buildFeedbackInvestigationPrompt(task, state);
        logger.info(`[Orchestrator] Pipeline ${taskId}: feedback investigation started`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, prompt);

        // 读取调查结论
        const conclusion = await this.readInvestigationResult(state, task);
        logger.info(`[Orchestrator] Pipeline ${taskId}: investigation conclusion = ${conclusion.action}`);

        if (!await this.isTaskStillRunning(goalId, taskId)) return;

        switch (conclusion.action) {
          case 'continue':
            // Claude 已在调查中修复了问题 → 走 audit → fix 循环验证
            await this.notify(state.goalChannelId,
              `[Pipeline] ${taskId}: 调查结论 — 问题已修复，进入审计验证`,
              'info',
            );
            this.startRefixPipeline(goalId, taskId, guildId, channelId, task, state);
            break;

          case 'retry':
            // 需要完全重试
            await this.notify(state.goalChannelId,
              `[Pipeline] ${taskId}: 调查结论 — 需要完全重试\n原因: ${conclusion.reason}`,
              'warning',
            );
            await this.withStateLock(goalId, async () => {
              const freshState = await this.getState(goalId);
              if (!freshState) return;
              const freshTask = freshState.tasks.find(t => t.id === taskId);
              if (!freshTask) return;
              // retryTask 要求 failed 状态，先改回 failed 再调用
              freshTask.status = 'failed';
              await this.saveState(freshState);
            });
            await this.retryTask(goalId, taskId);
            break;

          case 'replan':
            // 需要重新规划
            await this.notify(state.goalChannelId,
              `[Pipeline] ${taskId}: 调查结论 — 需要重新规划\n原因: ${conclusion.reason}`,
              'info',
            );
            await this.withStateLock(goalId, async () => {
              const freshState = await this.getState(goalId);
              if (!freshState) return;
              const freshTask = freshState.tasks.find(t => t.id === taskId);
              if (!freshTask) return;
              freshTask.status = 'completed';
              freshTask.completedAt = Date.now();
              await this.saveState(freshState);
              await this.triggerReplan(freshState, taskId, {
                type: 'replan',
                reason: conclusion.reason,
                details: conclusion.details,
              });
              const refreshed = await this.getState(goalId);
              if (refreshed && refreshed.status === 'running') {
                await this.reviewAndDispatch(refreshed, taskId);
              }
            });
            break;

          case 'escalate':
          default:
            // 无法自动解决，交给用户
            await this.withStateLock(goalId, async () => {
              const freshState = await this.getState(goalId);
              if (!freshState) return;
              const freshTask = freshState.tasks.find(t => t.id === taskId);
              if (!freshTask) return;
              freshTask.status = 'blocked_feedback';
              freshTask.pipelinePhase = undefined;
              await this.saveState(freshState);
              await this.notify(freshState.goalChannelId,
                `[Pipeline] ${taskId}: AI 调查无法自动解决\n原因: ${conclusion.reason}\n需要人工干预。`,
                'error',
              );
            });
            break;
        }
      } catch (err: any) {
        const stillRunning = await this.isTaskStillRunning(goalId, taskId);
        if (!stillRunning) return;
        logger.error(`[Orchestrator] Feedback investigation failed for ${taskId}:`, err.message);
        // 调查本身失败 → 回到 blocked_feedback 等用户处理
        try {
          await this.withStateLock(goalId, async () => {
            const freshState = await this.getState(goalId);
            if (!freshState) return;
            const freshTask = freshState.tasks.find(t => t.id === taskId);
            if (!freshTask) return;
            freshTask.status = 'blocked_feedback';
            freshTask.pipelinePhase = undefined;
            await this.saveState(freshState);
            await this.notify(freshState.goalChannelId,
              `[Pipeline] ${taskId}: AI 调查出错: ${err.message}\n已回退到 blocked_feedback，需要人工干预。`,
              'error',
            );
          });
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] startFeedbackInvestigation cleanup also failed:`, cbErr.message);
        }
      }
    })();
  }

  /**
   * 构建 feedback 调查 prompt
   */
  private buildFeedbackInvestigationPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const fb = task.feedback!;

    // 构建依赖 section 文本
    let depSection = '';
    if (task.depends.length > 0) {
      const depInfos = task.depends.map(depId => {
        const dep = state.tasks.find(t => t.id === depId);
        if (!dep) return `  - ${depId}: (unknown)`;
        return `  - ${this.getTaskLabel(state, dep.id)}: ${dep.description} (status: ${dep.status}, merged: ${dep.merged ?? false})`;
      });
      depSection = `## Dependencies\n${depInfos.join('\n')}\n\n`;
    }

    // 构建 feedback details 文本
    const feedbackDetails = fb.details ? `Details: ${fb.details}` : '';

    return ps.render('orchestrator.feedback_investigation', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: this.getTaskLabel(state, task.id),
      TASK_DESCRIPTION: task.description,
      FEEDBACK_TYPE: fb.type,
      FEEDBACK_REASON: fb.reason,
      FEEDBACK_DETAILS: feedbackDetails,
      DEP_SECTION: depSection,
      GOAL_BRANCH: state.goalBranch,
      TASK_ID: task.id,
    });
  }

  /**
   * 读取调查结论文件 feedback/<taskId>-investigate.json
   */
  private async readInvestigationResult(
    state: GoalDriveState,
    task: GoalTask,
  ): Promise<{ action: string; reason: string; details?: string }> {
    const defaultResult = { action: 'escalate', reason: 'Investigation result file not found or unreadable' };

    if (!task.branchName) {
      logger.warn(`[Orchestrator] readInvestigationResult(${task.id}): no branchName`);
      return defaultResult;
    }

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `readInvestigationResult(${task.id}): list worktrees`,
      );
      const subtaskDir = this.findWorktreeDir(stdout, task.branchName);
      if (!subtaskDir) {
        logger.warn(`[Orchestrator] readInvestigationResult(${task.id}): worktree not found`);
        return defaultResult;
      }

      const resultPath = join(subtaskDir, 'feedback', `${task.id}-investigate.json`);
      const content = await readFile(resultPath, 'utf-8');
      const parsed = JSON.parse(content);

      const validActions = ['continue', 'retry', 'replan', 'escalate'];
      const action = validActions.includes(parsed.action) ? parsed.action : 'escalate';

      return {
        action,
        reason: parsed.reason || 'No reason provided',
        details: parsed.details,
      };
    } catch (err: any) {
      logger.warn(`[Orchestrator] readInvestigationResult(${task.id}): ${err.message}`);
      return defaultResult;
    }
  }

  // ========== Brain 战略大脑 ==========

  /**
   * 向 Brain channel 发送事件消息
   */
  private async sendToBrain(
    state: GoalDriveState,
    message: string,
  ): Promise<void> {
    if (!state.brainChannelId) return;
    const guildId = this.getGuildId();
    if (!guildId) return;
    try {
      await this.deps.messageHandler.handleBackgroundChat(
        guildId, state.brainChannelId, message,
      );
    } catch (err: any) {
      logger.warn(`[Orchestrator] sendToBrain failed: ${err.message}`);
    }
  }

  /**
   * 读取 Brain 写入的决策 JSON 文件
   *
   * Brain 将决策写入 goal worktree 的 feedback/ 目录。
   */
  private async readBrainDecision<T>(
    state: GoalDriveState,
    filename: string,
  ): Promise<T | null> {
    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `readBrainDecision(${filename}): list worktrees`,
      );
      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        logger.warn(`[Orchestrator] readBrainDecision: goal worktree not found`);
        return null;
      }

      const resultPath = join(goalWorktreeDir, 'feedback', filename);
      const content = await readFile(resultPath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err: any) {
      logger.warn(`[Orchestrator] readBrainDecision(${filename}): ${err.message}`);
      return null;
    }
  }

  /**
   * 获取 goal channel 所在的 Category ID（从 channel 向上查找）
   */
  private async findCategoryId(goalChannelId: string): Promise<string | null> {
    try {
      let channel = await this.deps.client.channels.fetch(goalChannelId);
      for (let i = 0; i < 3 && channel; i++) {
        if (channel.type === ChannelType.GuildCategory) {
          return channel.id;
        }
        if ('parentId' in channel && channel.parentId) {
          channel = await this.deps.client.channels.fetch(channel.parentId);
        } else {
          break;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 创建 Brain channel + session 并发送初始化消息
   */
  private async createBrain(
    state: GoalDriveState,
    goalMeta: { body?: string | null; completion?: string | null } | null,
  ): Promise<void> {
    const guildId = this.getGuildId();
    if (!guildId) return;

    const categoryId = await this.findCategoryId(state.goalChannelId);
    if (!categoryId) {
      logger.warn(`[Orchestrator] createBrain: cannot find category, skipping brain creation`);
      return;
    }

    try {
      const guild = await this.deps.client.guilds.fetch(guildId);
      const brainChannel = await guild.channels.create({
        name: `brain-${state.goalName}`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: `Goal brain: ${state.goalName}`,
      });

      // 创建 Opus session
      const goalWorktreeDir = await this.getGoalWorktreeDir(state);
      const cwd = goalWorktreeDir ?? state.baseCwd;
      this.deps.stateManager.getOrCreateSession(guildId, brainChannel.id, {
        name: `brain-${state.goalName}`,
        cwd,
      });
      this.switchSessionModel(guildId, brainChannel.id, this.deps.config.pipelineOpusModel);

      state.brainChannelId = brainChannel.id;
      await this.saveState(state);

      // 发送初始化消息
      const ps = this.deps.promptService;
      const tasksSummary = state.tasks.map(t =>
        `- ${this.getTaskLabel(state, t.id)}: [${t.type}] ${t.description} (${t.status})`,
      ).join('\n');

      const initPrompt = ps.render('orchestrator.brain_init', {
        GOAL_NAME: state.goalName,
        GOAL_BODY: goalMeta?.body || '(no body)',
        COMPLETION_CRITERIA: goalMeta?.completion || '(not specified)',
        CURRENT_TASKS: tasksSummary,
      });

      await this.sendToBrain(state, initPrompt);

      await this.notify(state.goalChannelId,
        `Brain created for "${state.goalName}"`,
        'info',
      );
    } catch (err: any) {
      logger.error(`[Orchestrator] createBrain failed: ${err.message}`);
    }
  }

  /**
   * 获取 goal worktree 目录
   */
  private async getGoalWorktreeDir(state: GoalDriveState): Promise<string | null> {
    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `getGoalWorktreeDir: list worktrees`,
      );
      return this.findWorktreeDir(stdout, state.goalBranch);
    } catch {
      return null;
    }
  }

  /**
   * 归档 Brain channel（goal 完成时调用）
   */
  private async archiveBrainChannel(state: GoalDriveState): Promise<void> {
    if (!state.brainChannelId) return;
    const guildId = this.getGuildId();
    if (!guildId) return;

    try {
      this.deps.stateManager.archiveSession(guildId, state.brainChannelId, undefined, 'completed');
      const channel = await this.deps.client.channels.fetch(state.brainChannelId);
      if (channel && 'delete' in channel) {
        await (channel as any).delete('Goal completed — brain archived');
      }
    } catch (err: any) {
      logger.warn(`[Orchestrator] archiveBrainChannel: ${err.message}`);
    }
    state.brainChannelId = undefined;
    await this.saveState(state);
  }

  /**
   * 暂停正在运行的任务：中止 Claude 子进程，保留 branch/thread/session 上下文
   */
  async pauseTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return false;

    // 中止运行中的 Claude 进程（保留队列，但任务暂停后不需要队列）
    if (task.channelId) {
      const guildId = this.getGuildId();
      if (guildId) {
        const lockKey = StateManager.channelLockKey(guildId, task.channelId);
        this.deps.claudeClient.abort(lockKey);
      }
    }

    task.status = 'paused';
    // 保留 branchName, threadId, dispatchedAt — 恢复时复用
    await this.saveState(state);
    await this.notify(state.goalChannelId,
      `Paused task: ${this.getTaskLabel(state, task.id)} - ${task.description}\nBranch/thread preserved for resume.`,
      'warning'
    );
    return true;
  }

  /**
   * 恢复暂停的任务：使用保留的 branch/thread 重新执行
   */
  async resumeTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'paused') return false;

    const guildId = this.getGuildId();
    if (!guildId) return false;

    // 任务有保留的 thread 和 branch → 在原有 thread 中继续执行
    if (task.channelId && task.branchName) {
      task.status = 'running';
      await this.saveState(state);
      await this.notify(state.goalChannelId,
        `Resumed task: ${this.getTaskLabel(state, task.id)} - ${task.description}`,
        'success'
      );

      const taskPrompt = `[Resumed] Continue working on this task. Your previous progress has been preserved.\n\n` +
        this.buildTaskPrompt(task, state);
      this.executeTaskInBackground(state.goalId, task.id, guildId, task.channelId, taskPrompt);
      return true;
    }

    // 没有保留上下文 → 重置为 pending，重新派发
    task.status = 'pending';
    task.branchName = undefined;
    task.channelId = undefined;
    task.dispatchedAt = undefined;
    await this.saveState(state);
    await this.notify(state.goalChannelId,
      `Resumed task: ${this.getTaskLabel(state, task.id)} - ${task.description} (re-dispatch)`,
      'success'
    );
    if (state.status === 'running') await this.dispatchNext(state);
    return true;
  }

  async restoreRunningDrives(): Promise<void> {
    const states = await this.deps.goalRepo.findByStatus('running');
    for (const state of states) {
      try {
        await stat(state.baseCwd);
      } catch {
        logger.error(`[Orchestrator] baseCwd does not exist for ${state.goalName}: ${state.baseCwd}`);
        state.status = 'paused';
        await this.saveState(state);
        await this.notify(state.goalChannelId,
          `Goal "${state.goalName}" restore failed: working directory not found\n` +
          `Path: ${state.baseCwd}\n` +
          `Auto-paused. Check and resume manually.`,
          'error'
        );
        continue;
      }

      // Reset running/dispatched tasks: worktree missing → failed, else → pending (re-dispatch)
      let stateModified = false;
      for (const task of state.tasks) {
        if ((task.status === 'running' || task.status === 'dispatched') && task.branchName) {
          try {
            const stdout = await execGit(
              ['worktree', 'list', '--porcelain'],
              state.baseCwd,
              `restoreRunningDrives: check worktree for ${task.id}`
            );
            const worktreeDir = this.findWorktreeDir(stdout, task.branchName);
            if (!worktreeDir) {
              logger.warn(`[Orchestrator] Worktree missing for task ${task.id} (${task.branchName}), marking failed`);
              task.status = 'failed';
              task.error = 'Worktree not found after restart';
            } else {
              // Worktree exists but process is gone — reset to pending for re-dispatch
              logger.info(`[Orchestrator] Resetting task ${task.id} to pending for re-dispatch`);
              task.status = 'pending';
              task.branchName = undefined;
              task.channelId = undefined;
              task.dispatchedAt = undefined;
              task.pipelinePhase = undefined;
              task.auditRetries = 0;
            }
            stateModified = true;
          } catch {
            task.status = 'failed';
            task.error = 'Cannot verify worktree after restart';
            stateModified = true;
          }
        }
      }
      // Brain channel 恢复检查
      if (state.brainChannelId) {
        try {
          const ch = await this.deps.client.channels.fetch(state.brainChannelId);
          if (!ch) throw new Error('Channel not found');
          logger.info(`[Orchestrator] Brain channel restored: ${state.brainChannelId}`);
        } catch {
          logger.warn(`[Orchestrator] Brain channel ${state.brainChannelId} missing, clearing`);
          state.brainChannelId = undefined;
          stateModified = true;
        }
      }

      if (stateModified) await this.saveState(state);

      this.activeDrives.set(state.goalId, state);
      logger.info(`[Orchestrator] Restored drive: ${state.goalName} (${state.goalId})`);
      await this.reviewAndDispatch(state);
    }
    if (states.length > 0) {
      logger.info(`[Orchestrator] Restored ${states.length} running drives`);
    }
  }

  // ========== 内部方法 ==========

  private async getState(goalId: string): Promise<GoalDriveState | null> {
    return this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
  }

  private async saveState(state: GoalDriveState): Promise<void> {
    state.updatedAt = Date.now();
    await this.deps.goalRepo.save(state);
  }

  /**
   * 增强型任务分发 — 在 dispatchNext() 前增加审查层
   *
   * 审查顺序：
   * 1. 占位任务检查：待分发队列若包含占位任务 → 强制 replan
   * 2. 调研任务深度审查：刚完成的调研任务（无显式 replan feedback）→ 触发深度审查 + replan
   * 3. Feedback 分发：有 blocked_feedback 状态的任务 → 按 feedback.type 路由
   * 4. 无触发条件 → 走原有 dispatchNext() 正常分发
   *
   * @param completedTaskId - 刚完成的任务 ID（可选，用于调研任务审查）
   */
  private async reviewAndDispatch(
    state: GoalDriveState,
    completedTaskId?: string,
  ): Promise<void> {
    if (state.status !== 'running') return;

    // ── 审查 1: 占位任务拦截 ──
    // 查看待分发队列中是否有占位任务变为可达状态（依赖已满足）
    const pendingPlaceholders = state.tasks.filter(t =>
      t.status === 'pending' && t.type === '占位' &&
      t.depends.every(depId => {
        const dep = state.tasks.find(d => d.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'skipped' || dep.status === 'cancelled');
      })
    );
    if (pendingPlaceholders.length > 0) {
      const placeholderIds = pendingPlaceholders.map(t => t.id).join(', ');
      logger.info(`[Orchestrator] Placeholder tasks ready: ${placeholderIds} — forcing replan`);
      await this.notify(state.goalChannelId,
        `**占位任务触发重规划:** ${placeholderIds}\n` +
        `占位任务的依赖已满足，需要重新规划将其替换为具体任务。`,
        'info',
      );

      // 用第一个占位任务触发 replan
      const trigger = pendingPlaceholders[0];
      await this.triggerReplan(state, trigger.id, {
        type: 'replan',
        reason: `占位任务 ${placeholderIds} 的依赖已满足，需要将占位任务替换为具体可执行任务`,
        details: `placeholder_ids: ${placeholderIds}`,
      });

      // replan 后刷新 state 再继续调度（replan 可能改变了任务图）
      const refreshed = await this.getState(state.goalId);
      if (refreshed && refreshed.status === 'running') {
        await this.dispatchNext(refreshed);
      }
      return;
    }

    // ── 审查 2: 调研任务深度审查 ──
    // 刚完成的调研任务如果没有写 replan feedback，主动触发深度审查
    if (completedTaskId) {
      const completedTask = state.tasks.find(t => t.id === completedTaskId);
      if (
        completedTask &&
        completedTask.type === '调研' &&
        completedTask.status === 'completed' &&
        (!completedTask.feedback || completedTask.feedback.type !== 'replan')
      ) {
        logger.info(
          `[Orchestrator] Research task ${completedTaskId} completed without replan feedback — triggering deep review`,
        );
        await this.notify(state.goalChannelId,
          `**调研任务深度审查:** ${completedTask.id} - ${completedTask.description}\n` +
          `调研任务完成但未提交 replan feedback，自动触发深度审查。`,
          'info',
        );

        await this.triggerReplan(state, completedTask.id, {
          type: 'replan',
          reason: `调研任务 ${completedTask.id} 已完成，自动触发深度审查以评估调研结果对后续任务的影响`,
        });

        const refreshed = await this.getState(state.goalId);
        if (refreshed && refreshed.status === 'running') {
          await this.dispatchNext(refreshed);
        }
        return;
      }
    }

    // ── 审查 3: Feedback 待处理任务路由 ──
    // 检查是否有 blocked_feedback 状态的任务需要按 type 路由处理
    const feedbackTasks = state.tasks.filter(t => t.status === 'blocked_feedback' && t.feedback);
    for (const task of feedbackTasks) {
      const fb = task.feedback!;
      switch (fb.type) {
        case 'blocked':
        case 'clarify': {
          // blocked/clarify：如果有 thread 上下文，启动 AI 调查
          if (task.channelId) {
            const guildId = this.getGuildId();
            if (guildId) {
              task.status = 'running';
              task.pipelinePhase = 'fix';
              await this.saveState(state);
              this.startFeedbackInvestigation(state, task, guildId);
              // 不 return —— 继续处理其他任务，调查异步进行
              continue;
            }
          }
          // 没有 thread 上下文，只能等用户干预
          break;
        }

        case 'replan':
          // replan 类型正常应该在 onTaskCompleted 中已处理
          // 这里作为兜底：如果意外到达此状态，触发 replan
          logger.warn(`[Orchestrator] Unexpected replan feedback in blocked_feedback state: ${task.id}`);
          task.status = 'completed';
          task.completedAt = Date.now();
          await this.saveState(state);
          await this.triggerReplan(state, task.id, fb);
          const refreshed = await this.getState(state.goalId);
          if (refreshed && refreshed.status === 'running') {
            await this.dispatchNext(refreshed);
          }
          return;

        default:
          // 未知 feedback 类型：记录日志，不阻塞调度
          logger.warn(`[Orchestrator] Unknown feedback type "${fb.type}" on task ${task.id}`);
          break;
      }
    }

    // ── 审查通过：走正常分发 ──
    await this.dispatchNext(state);
  }

  private async dispatchNext(state: GoalDriveState): Promise<void> {
    if (state.status !== 'running') return;

    if (isGoalComplete(state)) {
      state.status = 'completed';
      await this.saveState(state);
      await this.syncGoalMetaStatus(state.goalId, 'Completed');
      await this.archiveBrainChannel(state);
      await this.notify(state.goalChannelId,
        `**Goal "${state.goalName}" completed!**\n` +
        `Review branch \`${state.goalBranch}\` and merge to main.`,
        'success'
      );
      return;
    }

    if (isGoalStuck(state)) {
      await this.syncGoalMetaStatus(state.goalId, 'Blocking');
      await this.notify(state.goalChannelId,
        `Goal "${state.goalName}" is stuck\n` +
        `May have unresolved dependencies or failed tasks\n` +
        `Progress: ${getProgressSummary(state)}`,
        'warning'
      );
      return;
    }

    const batch = getNextBatch(state);

    const blockedTasks = state.tasks.filter(t => t.status === 'blocked');
    for (const task of blockedTasks) {
      if (!task.notifiedBlocked) {
        task.notifiedBlocked = true;
        await this.notify(state.goalChannelId,
          `Manual task pending: ${this.getTaskLabel(state, task.id)} - ${task.description}\nReply "done ${task.id}" when complete.`,
          'warning'
        );
      }
    }

    await this.saveState(state);

    for (const task of batch) {
      await this.dispatchTask(state, task);
    }
  }

  private async dispatchTask(state: GoalDriveState, task: GoalTask): Promise<void> {
    const branchName = await this.generateBranchName(task, state);
    task.branchName = branchName;
    task.status = 'dispatched';
    task.dispatchedAt = Date.now();
    await this.saveState(state);

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `dispatchTask(${task.id}): list worktrees`
      );

      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        throw new Error(`Goal worktree for ${state.goalBranch} not found`);
      }

      const subtaskDir = await createSubtaskBranch(
        goalWorktreeDir,
        branchName,
        this.deps.config.worktreesDir
      );

      const guildId = this.getGuildId();
      if (!guildId) throw new Error('Bot not authorized');

      const categoryId = await this.findCategoryId(state.goalChannelId);

      if (!categoryId) {
        throw new Error('Cannot find Category for goal channel');
      }

      const guild = await this.deps.client.guilds.fetch(guildId);
      const title = await generateTopicTitle(task.description);
      const taskLabel = this.getTaskLabel(state, task.id);
      const channelName = `${taskLabel} ${title}`.slice(0, 100);

      const textChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: `Goal subtask: ${taskLabel}`,
      });

      // 发送初始消息
      const initEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[goal] Task: \`${taskLabel}\` - ${task.description}\nBranch: \`${branchName}\`\nWorking directory: \`${subtaskDir}\``.slice(0, 4096));
      await textChannel.send({ embeds: [initEmbed] });

      const newThreadId = textChannel.id;

      this.deps.stateManager.getOrCreateSession(guildId, newThreadId, {
        name: channelName,
        cwd: subtaskDir,
      });
      this.deps.stateManager.setSessionForkInfo(guildId, newThreadId, state.goalChannelId, branchName);

      task.channelId = newThreadId;
      task.status = 'running';
      await this.saveState(state);

      await this.notify(state.goalChannelId,
        `Dispatched: ${taskLabel} - ${task.description} → \`${branchName}\``,
        'info'
      );

      this.executeTaskPipeline(state.goalId, task.id, guildId, newThreadId, task, state);

    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      await this.saveState(state);
      await this.notify(state.goalChannelId,
        `Dispatch failed: ${this.getTaskLabel(state, task.id)} - ${task.description}\nError: ${err.message}`,
        'error'
      );
    }
  }

  // ========== Usage 累加辅助 ==========

  private emptyUsage(): ChatUsageResult {
    return {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      total_cost_usd: 0, duration_ms: 0,
    };
  }

  private accumulateUsage(total: ChatUsageResult, single: ChatUsageResult): void {
    total.input_tokens += single.input_tokens;
    total.output_tokens += single.output_tokens;
    total.cache_read_input_tokens += single.cache_read_input_tokens;
    total.cache_creation_input_tokens += single.cache_creation_input_tokens;
    total.total_cost_usd += single.total_cost_usd;
    total.duration_ms += single.duration_ms;
  }

  private executeTaskInBackground(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    message: string
  ): void {
    (async () => {
      const usage = this.emptyUsage();
      try {
        logger.info(`[Orchestrator] Task ${taskId} executing in channel ${channelId}`);
        const u = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, message);
        this.accumulateUsage(usage, u);
        logger.info(`[Orchestrator] Task ${taskId} completed`);
        await this.onTaskCompleted(goalId, taskId, usage);
      } catch (err: any) {
        logger.error(`[Orchestrator] Task ${taskId} failed:`, err.message);
        try {
          await this.onTaskFailed(goalId, taskId, err.message, usage);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr.message);
        }
      }
    })();
  }

  // ========== 多模型流水线 ==========

  /**
   * 切换 session 到新模型，智能复用已有 session
   * - execute: 创建新 sonnet/opus session
   * - audit: 创建新 opus session（独立）
   * - fix: 复用 execute 的 sonnet session ← 关键优化
   * - plan: 创建新 opus session
   */
  private switchSessionModel(
    guildId: string,
    channelId: string,
    model: string,
    phase?: GoalPipelinePhase
  ): void {
    // 判断模型槽位（opus 或 其他都归为 sonnet）
    const modelSlot: 'sonnet' | 'opus' =
      model.toLowerCase().includes('opus') ? 'opus' : 'sonnet';

    // Fix 阶段：复用 execute 阶段的 sonnet session（通过 link 查找）
    if (phase === 'fix' && modelSlot === 'sonnet') {
      const activeLinks = this.deps.stateManager.getActiveLinks(channelId);
      const sonnetLink = activeLinks.find(l => l.model && !l.model.toLowerCase().includes('opus'));
      const existingSessionId = sonnetLink?.claudeSessionId;
      if (existingSessionId) {
        // 恢复到已有的 sonnet session
        this.deps.stateManager.setSessionClaudeId(guildId, channelId, existingSessionId);
        this.deps.stateManager.setSessionModel(guildId, channelId, model);
        logger.info(`[Orchestrator] Reusing Sonnet session for fix: ${existingSessionId.slice(0, 8)}`);
        return;
      }
      logger.warn(`[Orchestrator] No saved Sonnet session, creating new one for fix`);
    }

    // 其他阶段：清除并创建新 session
    this.deps.stateManager.clearSessionClaudeId(guildId, channelId);
    this.deps.stateManager.setSessionModel(guildId, channelId, model);
  }

  private async updatePipelinePhase(goalId: string, taskId: string, phase: GoalPipelinePhase): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.pipelinePhase = phase;
      await this.saveState(state);
    });
  }

  private async updateAuditRetries(goalId: string, taskId: string, count: number): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.auditRetries = count;
      await this.saveState(state);
    });
  }

  /**
   * 检查任务当前是否仍在 running 状态（防止 pipeline 操作过期引用）
   * 在 pipeline 各 phase 之间调用，如果任务已被外部修改（skip/cancel/retry），中止 pipeline
   */
  private async isTaskStillRunning(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    return task?.status === 'running';
  }

  private async getTaskStatus(goalId: string, taskId: string): Promise<string> {
    const state = await this.getState(goalId);
    if (!state) return 'unknown';
    const task = state.tasks.find(t => t.id === taskId);
    return task?.status ?? 'unknown';
  }

  /**
   * 流水线路由 — 根据 task.type + task.complexity 分发到对应路径
   */
  private executeTaskPipeline(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
  ): void {
    const usage = this.emptyUsage();
    (async () => {
      try {
        if (task.type === '调研') {
          await this.pipelineResearch(goalId, taskId, guildId, channelId, task, state, usage);
        } else if (task.type === '代码' && task.complexity === 'complex') {
          await this.pipelineComplexCode(goalId, taskId, guildId, channelId, task, state, usage);
        } else {
          // 默认路径：代码(simple/无标注) 和其他类型
          await this.pipelineSimpleCode(goalId, taskId, guildId, channelId, task, state, usage);
        }
      } catch (err: any) {
        logger.error(`[Orchestrator] Pipeline ${taskId} failed:`, err.message);
        // 检查任务是否已被用户操作修改（skip/pause/retry）
        // 如果已不是 running 状态，不要用 onTaskFailed 覆盖
        const stillRunning = await this.isTaskStillRunning(goalId, taskId);
        if (!stillRunning) {
          logger.info(`[Orchestrator] Pipeline ${taskId}: task already ${await this.getTaskStatus(goalId, taskId)}, skipping onTaskFailed`);
          return;
        }
        try {
          await this.onTaskFailed(goalId, taskId, err.message, usage);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr.message);
        }
      }
    })();
  }

  /**
   * 调研路径：Opus 执行 → onTaskCompleted
   */
  private async pipelineResearch(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
    usage: ChatUsageResult,
  ): Promise<void> {
    const opusModel = this.deps.config.pipelineOpusModel;
    this.switchSessionModel(guildId, channelId, opusModel, 'execute');
    await this.updatePipelinePhase(goalId, taskId, 'execute');

    await this.notify(state.goalChannelId,
      `[Pipeline] ${taskId}: 调研路径 → Opus 执行`,
      'pipeline',
    );

    const taskPrompt = this.buildTaskPrompt(task, state);
    logger.info(`[Orchestrator] Pipeline ${taskId}: research → Opus execute`);
    const u = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, taskPrompt);
    this.accumulateUsage(usage, u);

    if (!await this.isTaskStillRunning(goalId, taskId)) {
      logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running after execute, aborting pipeline`);
      return;
    }
    await this.onTaskCompleted(goalId, taskId, usage);
  }

  /**
   * 简单代码路径：Sonnet 执行 → Opus audit → [pass: 完成 / fail: Sonnet 修复(≤2次)]
   */
  private async pipelineSimpleCode(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
    usage: ChatUsageResult,
  ): Promise<void> {
    const { pipelineSonnetModel: sonnetModel } = this.deps.config;

    // Phase 1: Sonnet 执行
    this.switchSessionModel(guildId, channelId, sonnetModel, 'execute');
    await this.updatePipelinePhase(goalId, taskId, 'execute');

    await this.notify(state.goalChannelId,
      `[Pipeline] ${taskId}: 简单代码 → Sonnet 执行`,
      'pipeline',
    );

    const taskPrompt = this.buildTaskPrompt(task, state);
    logger.info(`[Orchestrator] Pipeline ${taskId}: simple code → Sonnet execute`);
    const execUsage = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, taskPrompt);
    this.accumulateUsage(usage, execUsage);

    // 检查任务是否仍在 running（可能被 skip/cancel/retry）
    if (!await this.isTaskStillRunning(goalId, taskId)) {
      logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running after execute, aborting pipeline`);
      return;
    }

    // 检查 feedback 文件：如果 Sonnet 写了 feedback（blocked/clarify），跳过 audit
    const preFeedback = await this.checkFeedbackFile(state, task);
    if (preFeedback) {
      logger.info(`[Orchestrator] Pipeline ${taskId}: feedback detected after execute, skipping audit`);
      await this.onTaskCompleted(goalId, taskId);
      return;
    }

    // Phase 2: Opus audit
    const auditResult = await this.runAudit(goalId, taskId, guildId, channelId, task, state, usage);

    if (auditResult.verdict === 'pass') {
      await this.onTaskCompleted(goalId, taskId, usage);
      return;
    }

    // Audit 失败 → Sonnet 修复（最多 2 次）
    await this.auditFixLoop(goalId, taskId, guildId, channelId, task, state, auditResult.summary, auditResult.issues, auditResult.verifyCommands, usage);
  }

  /**
   * 复杂代码路径：Opus plan → Sonnet 执行 → Opus audit → [同上重试]
   */
  private async pipelineComplexCode(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
    usage: ChatUsageResult,
  ): Promise<void> {
    const { pipelineOpusModel: opusModel, pipelineSonnetModel: sonnetModel } = this.deps.config;

    // Phase 1: Opus plan
    this.switchSessionModel(guildId, channelId, opusModel, 'plan');
    await this.updatePipelinePhase(goalId, taskId, 'plan');

    await this.notify(state.goalChannelId,
      `[Pipeline] ${taskId}: 复杂代码 → Opus 规划`,
      'pipeline',
    );

    const planPrompt = this.buildPlanPrompt(task, state);
    logger.info(`[Orchestrator] Pipeline ${taskId}: complex code → Opus plan`);
    const planUsage = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, planPrompt);
    this.accumulateUsage(usage, planUsage);

    if (!await this.isTaskStillRunning(goalId, taskId)) {
      logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running after plan, aborting pipeline`);
      return;
    }

    // 验证 plan 文件是否写入
    const planExists = await this.checkPlanFileExists(state, task);
    if (!planExists) {
      logger.warn(`[Orchestrator] Pipeline ${taskId}: .task-plan.md not found after plan phase, Sonnet will execute without plan`);
      await this.notify(state.goalChannelId,
        `[Pipeline] ${taskId}: Opus 未写入 .task-plan.md，Sonnet 将自行理解任务执行`,
        'warning',
      );
    }

    // Phase 2: Sonnet 执行（读 plan）
    this.switchSessionModel(guildId, channelId, sonnetModel, 'execute');
    await this.updatePipelinePhase(goalId, taskId, 'execute');

    await this.notify(state.goalChannelId,
      `[Pipeline] ${taskId}: 复杂代码 → Sonnet 执行${planExists ? '（按 plan）' : '（无 plan fallback）'}`,
      'pipeline',
    );

    // 根据 plan 是否存在选择不同的 prompt
    const executePrompt = planExists
      ? this.buildExecuteWithPlanPrompt(task, state)
      : this.buildTaskPrompt(task, state);
    logger.info(`[Orchestrator] Pipeline ${taskId}: complex code → Sonnet execute with plan`);
    const execUsage = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, executePrompt);
    this.accumulateUsage(usage, execUsage);

    if (!await this.isTaskStillRunning(goalId, taskId)) {
      logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running after execute, aborting pipeline`);
      return;
    }

    // 检查 feedback 文件：如果 Sonnet 写了 feedback（blocked/clarify），跳过 audit
    const preFeedback = await this.checkFeedbackFile(state, task);
    if (preFeedback) {
      logger.info(`[Orchestrator] Pipeline ${taskId}: feedback detected after execute, skipping audit`);
      await this.onTaskCompleted(goalId, taskId);
      return;
    }

    // Phase 3: Opus audit
    const auditResult = await this.runAudit(goalId, taskId, guildId, channelId, task, state, usage);

    if (auditResult.verdict === 'pass') {
      await this.onTaskCompleted(goalId, taskId, usage);
      return;
    }

    // Audit 失败 → Sonnet 修复
    await this.auditFixLoop(goalId, taskId, guildId, channelId, task, state, auditResult.summary, auditResult.issues, auditResult.verifyCommands, usage);
  }

  /**
   * Audit 失败后的修复循环：Sonnet fix → re-audit（最多 2 次）
   */
  private async auditFixLoop(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
    auditSummary: string | undefined,
    issues: string[],
    verifyCommands: string[] = [],
    usage: ChatUsageResult,
  ): Promise<void> {
    const { pipelineSonnetModel: sonnetModel } = this.deps.config;
    const maxRetries = 2;
    const maxSelfReviewRetries = 1;  // Self-review 失败后的 refix 次数上限

    for (let retry = 1; retry <= maxRetries; retry++) {
      if (!await this.isTaskStillRunning(goalId, taskId)) {
        logger.info(`[Orchestrator] Pipeline ${taskId}: task no longer running in fix loop, aborting`);
        return;
      }

      await this.updateAuditRetries(goalId, taskId, retry);

      // Sonnet fix
      this.switchSessionModel(guildId, channelId, sonnetModel, 'fix');
      await this.updatePipelinePhase(goalId, taskId, 'fix');

      await this.notify(state.goalChannelId,
        `[Pipeline] ${taskId}: Audit 失败 → Sonnet 修复 (${retry}/${maxRetries})`,
        'pipeline',
      );

      const fixPrompt = this.buildFixPrompt(task, state, auditSummary, issues, verifyCommands);
      logger.info(`[Orchestrator] Pipeline ${taskId}: Sonnet fix attempt ${retry}`);
      const fixUsage = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, fixPrompt);
      this.accumulateUsage(usage, fixUsage);

      // Self-review（在同一 Sonnet session 中自查修复质量）
      const selfReviewResult = await this.runSelfReview(
        goalId, taskId, guildId, channelId, task, state, issues, verifyCommands, usage
      );

      if (selfReviewResult.hasRemainingIssues) {
        logger.info(`[Orchestrator] Pipeline ${taskId}: Self-review found ${selfReviewResult.remainingIssues.length} issues`);

        // Self-review 失败：允许有限次 refix，避免耗尽重试机会
        if (retry < maxRetries) {
          logger.info(`[Orchestrator] Pipeline ${taskId}: Attempting refix based on self-review feedback`);
          issues = selfReviewResult.remainingIssues;
          continue;  // 继续下一轮 fix
        } else {
          logger.warn(`[Orchestrator] Pipeline ${taskId}: Self-review still found issues but retries exhausted, proceeding to Opus audit anyway`);
          // 最后一次重试：即使 self-review 失败也进入 Opus audit（让 Opus 做最终判断）
        }
      }

      // Self-review 通过 → Opus re-audit
      await this.notify(state.goalChannelId,
        `[Pipeline] ${taskId}: Self-review 通过 → Opus 二次审查`,
        'pipeline',
      );

      const reAudit = await this.runAudit(goalId, taskId, guildId, channelId, task, state, usage);
      if (reAudit.verdict === 'pass') {
        await this.onTaskCompleted(goalId, taskId, usage);
        return;
      }
      // 更新所有变量（包括 summary）
      auditSummary = reAudit.summary;
      issues = reAudit.issues;
      verifyCommands = reAudit.verifyCommands;
    }

    // 所有重试耗尽 → 标记失败
    logger.warn(`[Orchestrator] Pipeline ${taskId}: audit fix exhausted after ${maxRetries} retries`);
    await this.onTaskFailed(goalId, taskId, `Audit failed after ${maxRetries} fix attempts. Issues: ${issues.join('; ')}`, usage);
  }

  /**
   * Sonnet self-review：在同一 session 中自查修复质量
   */
  private async runSelfReview(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
    originalIssues: string[],
    verifyCommands: string[],
    usage: ChatUsageResult,
  ): Promise<{ hasRemainingIssues: boolean; remainingIssues: string[] }> {
    await this.notify(state.goalChannelId, `[Pipeline] ${taskId}: Sonnet 自查中...`, 'pipeline');

    const selfReviewPrompt = this.buildSelfReviewPrompt(task, state, originalIssues, verifyCommands);
    const reviewUsage = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, selfReviewPrompt);
    this.accumulateUsage(usage, reviewUsage);

    const result = await this.readSelfReviewResult(state, task);

    if (!result.hasRemainingIssues) {
      await this.notify(state.goalChannelId, `[Pipeline] ${taskId}: Self-review 通过 ✓`, 'success');
    } else {
      await this.notify(state.goalChannelId,
        `[Pipeline] ${taskId}: Self-review 发现 ${result.remainingIssues.length} 个遗留问题`,
        'warning',
      );
    }

    return result;
  }

  /**
   * 构建 Self-review prompt
   */
  private buildSelfReviewPrompt(
    task: GoalTask,
    state: GoalDriveState,
    originalIssues: string[],
    verifyCommands: string[],
  ): string {
    const ps = this.deps.promptService;
    const issueList = originalIssues.map((issue, i) => `  ${i + 1}. ${issue}`).join('\n');

    const verifyCmdsSection = verifyCommands.length > 0
      ? `3. Run these verification commands:\n${verifyCommands.map(c => `   - \`${c}\``).join('\n')}`
      : `3. Run build and test commands`;

    return ps.render('orchestrator.self_review', {
      TASK_LABEL: this.getTaskLabel(state, task.id),
      TASK_DESCRIPTION: task.description,
      ISSUE_LIST: issueList,
      VERIFY_COMMANDS_SECTION: verifyCmdsSection,
      TASK_ID: task.id,
    });
  }

  /**
   * 读取 self-review 结果
   */
  private async readSelfReviewResult(
    state: GoalDriveState,
    task: GoalTask,
  ): Promise<{ hasRemainingIssues: boolean; remainingIssues: string[] }> {
    if (!task.branchName) {
      return { hasRemainingIssues: true, remainingIssues: ['No branch name'] };
    }

    let subtaskDir: string | null = null;
    try {
      const stdout = await execGit(['worktree', 'list', '--porcelain'], state.baseCwd, '...');
      subtaskDir = this.findWorktreeDir(stdout, task.branchName);
    } catch (err: any) {
      return { hasRemainingIssues: true, remainingIssues: [`Cannot list worktrees: ${err.message}`] };
    }

    if (!subtaskDir) {
      return { hasRemainingIssues: true, remainingIssues: ['Worktree not found'] };
    }

    const reviewPath = join(subtaskDir, 'feedback', `${task.id}-self-review.json`);

    try {
      await access(reviewPath);
      const content = await readFile(reviewPath, 'utf-8');
      const parsed = JSON.parse(content);

      // 验证 JSON 结构
      if (typeof parsed !== 'object' || parsed === null) {
        logger.warn(`[Orchestrator] Self-review ${task.id}: Invalid JSON structure`);
        return { hasRemainingIssues: true, remainingIssues: ['Invalid self-review format'] };
      }

      // 验证 remainingIssues 是数组
      const remainingIssues = Array.isArray(parsed.remainingIssues) ? parsed.remainingIssues : [];

      return {
        hasRemainingIssues: parsed.allIssuesFixed !== true || remainingIssues.length > 0,
        remainingIssues,
      };
    } catch (err: any) {
      // 没写文件或解析失败 → 假定有问题（保守策略）
      logger.warn(`[Orchestrator] Self-review ${task.id}: Failed to read or parse - ${err.message}`);
      return { hasRemainingIssues: true, remainingIssues: ['Self-review file not found or invalid'] };
    }
  }

  /**
   * 运行 Opus audit：读取 git diff → 审查 → 返回 pass/fail
   */
  private async runAudit(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    task: GoalTask,
    state: GoalDriveState,
    usage: ChatUsageResult,
  ): Promise<{ verdict: 'pass' | 'fail'; summary?: string; issues: string[]; verifyCommands: string[] }> {
    const { pipelineOpusModel: opusModel } = this.deps.config;

    this.switchSessionModel(guildId, channelId, opusModel, 'audit');
    await this.updatePipelinePhase(goalId, taskId, 'audit');

    await this.notify(state.goalChannelId,
      `[Pipeline] ${taskId}: Opus 审查中...`,
      'pipeline',
    );

    const auditPrompt = this.buildAuditPrompt(task, state);
    logger.info(`[Orchestrator] Pipeline ${taskId}: Opus audit`);
    const auditUsage = await this.deps.messageHandler.handleBackgroundChat(guildId, channelId, auditPrompt);
    this.accumulateUsage(usage, auditUsage);

    // 读取 audit 结果文件
    const result = await this.readAuditResult(state, task);

    if (result.verdict === 'pass') {
      await this.notify(state.goalChannelId,
        `[Pipeline] ${taskId}: Audit 通过 ✓`,
        'success',
      );
    } else {
      await this.notify(state.goalChannelId,
        `[Pipeline] ${taskId}: Audit 未通过 — ${result.issues.length} 个问题`,
        'warning',
      );
    }

    return result;
  }

  /**
   * 读取 audit 结果文件 feedback/<taskId>-audit.json
   *
   * 安全策略：
   * - 文件不存在 → fail（Opus 没写 audit 结果，不能默认通过）
   * - 文件存在但解析失败 → fail
   * - verdict 缺失 → fail
   * - 只有明确 verdict="pass" 才算通过
   */

  /**
   * 检查 .task-plan.md 是否存在于子任务 worktree 中
   */
  private async checkPlanFileExists(state: GoalDriveState, task: GoalTask): Promise<boolean> {
    if (!task.branchName) return false;
    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `checkPlanFileExists(${task.id}): list worktrees`,
      );
      const subtaskDir = this.findWorktreeDir(stdout, task.branchName);
      if (!subtaskDir) return false;
      await access(join(subtaskDir, '.task-plan.md'));
      return true;
    } catch {
      return false;
    }
  }

  private async readAuditResult(
    state: GoalDriveState,
    task: GoalTask,
  ): Promise<{ verdict: 'pass' | 'fail'; summary?: string; issues: string[]; verifyCommands: string[] }> {
    const defaultResult = { verifyCommands: [] as string[] };

    if (!task.branchName) {
      logger.warn(`[Orchestrator] readAuditResult(${task.id}): no branchName, defaulting to fail`);
      return { verdict: 'fail', issues: ['No branch name — cannot locate audit result'], ...defaultResult };
    }

    let subtaskDir: string | null = null;
    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `readAuditResult(${task.id}): list worktrees`,
      );
      subtaskDir = this.findWorktreeDir(stdout, task.branchName);
    } catch (err: any) {
      logger.warn(`[Orchestrator] readAuditResult(${task.id}): cannot list worktrees: ${err.message}`);
      return { verdict: 'fail', issues: ['Cannot list worktrees to find audit result'], ...defaultResult };
    }

    if (!subtaskDir) {
      logger.warn(`[Orchestrator] readAuditResult(${task.id}): worktree not found for ${task.branchName}`);
      return { verdict: 'fail', issues: ['Worktree not found — cannot locate audit result'], ...defaultResult };
    }

    const auditPath = join(subtaskDir, 'feedback', `${task.id}-audit.json`);

    // 检查文件是否存在
    try {
      await access(auditPath);
    } catch {
      logger.warn(`[Orchestrator] readAuditResult(${task.id}): audit file not found at ${auditPath}`);
      return { verdict: 'fail', issues: ['Audit result file not found — auditor may not have written it'], ...defaultResult };
    }

    // 文件存在，读取并解析
    try {
      const content = await readFile(auditPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (!parsed.verdict) {
        logger.warn(`[Orchestrator] readAuditResult(${task.id}): verdict field missing in audit file`);
        return { verdict: 'fail', issues: ['Audit file exists but verdict field is missing'], ...defaultResult };
      }

      // 保留结构化信息：[severity] (file:line) description
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.map((i: any) => {
            if (typeof i === 'string') return i;
            const sev = i.severity || 'error';
            const loc = i.file ? ` (${i.file}${i.line ? ':' + i.line : ''})` : '';
            const desc = i.description || JSON.stringify(i);
            return `[${sev}]${loc} ${desc}`;
          })
        : [];

      const verifyCommands = Array.isArray(parsed.verifyCommands)
        ? parsed.verifyCommands.filter((c: any) => typeof c === 'string')
        : [];

      // 提取 summary（Opus 的整体审查评价）
      const summary = typeof parsed.summary === 'string' ? parsed.summary : undefined;

      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        summary,
        issues,
        verifyCommands,
      };
    } catch (err: any) {
      logger.warn(`[Orchestrator] readAuditResult(${task.id}): failed to parse audit file: ${err.message}`);
      return { verdict: 'fail', issues: [`Audit file parse error: ${err.message}`], ...defaultResult };
    }
  }

  // ========== 流水线 Prompts ==========

  /**
   * buildPlanPrompt — Opus plan phase（复杂代码）
   * 分析代码 → 写 .task-plan.md → commit → 不写实现代码
   */
  private buildPlanPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const parts: string[] = [];

    // 主模板
    parts.push(ps.render('orchestrator.plan', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_DESCRIPTION: task.description,
    }));

    // 条件 section：详细计划
    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.plan.detail_plan', {
        DETAIL_PLAN_TEXT: task.detailPlan,
      });
      if (s) parts.push(s);
    }

    // 条件 section：依赖
    if (task.depends.length > 0) {
      const depList = task.depends.map(depId => {
        const dep = state.tasks.find(t => t.id === depId);
        return dep ? `  - ${this.getTaskLabel(state, dep.id)}: ${dep.description} (${dep.status})` : `  - ${depId}: (unknown)`;
      }).join('\n');
      const s = ps.tryRender('orchestrator.plan.dependencies', { DEP_LIST: depList });
      if (s) parts.push(s);
    }

    // 固定 section：指令
    const instr = ps.tryRender('orchestrator.plan.instructions', { TASK_LABEL: label });
    if (instr) parts.push(instr);

    return parts.join('\n\n');
  }

  /**
   * buildExecuteWithPlanPrompt — Sonnet execute (复杂代码)
   * 先读 .task-plan.md → 按步骤实施 → 不偏离方向
   */
  private buildExecuteWithPlanPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const parts: string[] = [];

    // 主模板
    parts.push(ps.render('orchestrator.execute_with_plan', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_DESCRIPTION: task.description,
    }));

    // 条件 section：详细计划
    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.execute_with_plan.detail_plan', {
        DETAIL_PLAN_TEXT: task.detailPlan,
      });
      if (s) parts.push(s);
    }

    // 固定 section：指令 + feedback 协议
    const instr = ps.tryRender('orchestrator.execute_with_plan.instructions', { TASK_ID: task.id });
    if (instr) parts.push(instr);

    return parts.join('\n\n');
  }

  /**
   * buildAuditPrompt — Opus audit phase
   * 运行 build/test 验证 + 读 git diff → 审查正确性/完整性/bug → 写 audit verdict 文件
   */
  private buildAuditPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const parts: string[] = [];

    // 主模板
    parts.push(ps.render('orchestrator.audit', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_DESCRIPTION: task.description,
    }));

    // 条件 section：详细计划
    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.audit.detail_plan', {
        DETAIL_PLAN_TEXT: task.detailPlan,
      });
      if (s) parts.push(s);
    }

    // 固定 section：指令
    const instr = ps.tryRender('orchestrator.audit.instructions', {
      GOAL_BRANCH: state.goalBranch,
      TASK_ID: task.id,
      TASK_LABEL: label,
    });
    if (instr) parts.push(instr);

    return parts.join('\n\n');
  }

  /**
   * buildFixPrompt — Sonnet fix phase
   * 读 audit issues → 逐条修复 error 级别 → 运行验证命令 → 只修不加新功能
   */
  private buildFixPrompt(
    task: GoalTask,
    state: GoalDriveState,
    auditSummary: string | undefined,
    issues: string[],
    verifyCommands: string[] = [],
  ): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const issueList = issues.map((issue, i) => `  ${i + 1}. ${issue}`).join('\n');
    const parts: string[] = [];

    // 主模板
    parts.push(ps.render('orchestrator.fix', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_DESCRIPTION: task.description,
    }));

    // 条件 section：详细计划
    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.fix.detail_plan', {
        DETAIL_PLAN_TEXT: task.detailPlan,
      });
      if (s) parts.push(s);
    }

    // 条件 section：审查摘要
    if (auditSummary) {
      const s = ps.tryRender('orchestrator.fix.audit_summary', {
        AUDIT_SUMMARY: auditSummary,
      });
      if (s) parts.push(s);
    }

    // 固定 section：指令（含 issue 列表）
    const instr = ps.tryRender('orchestrator.fix.instructions', { ISSUE_LIST: issueList });
    if (instr) parts.push(instr);

    // 条件 section：验证命令
    if (verifyCommands.length > 0) {
      const cmds = verifyCommands.map(cmd => `   - \`${cmd}\``).join('\n');
      const s = ps.tryRender('orchestrator.fix.verify_section', { VERIFY_COMMANDS: cmds });
      if (s) parts.push(s);
    } else {
      const s = ps.tryRender('orchestrator.fix.verify_fallback', {});
      if (s) parts.push(s);
    }

    // 固定 section：关键规则
    const rules = ps.tryRender('orchestrator.fix.critical_rules', {});
    if (rules) parts.push(rules);

    return parts.join('\n\n');
  }

  private async onTaskCompleted(goalId: string, taskId: string, usage?: ChatUsageResult): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      // 写入 usage 数据
      if (usage) {
        task.tokensIn = usage.input_tokens;
        task.tokensOut = usage.output_tokens;
        task.cacheReadIn = usage.cache_read_input_tokens;
        task.cacheWriteIn = usage.cache_creation_input_tokens;
        task.costUsd = usage.total_cost_usd;
        task.durationMs = usage.duration_ms;
      }

      // 检测 feedback 文件：worktree/feedback/<taskId>.json
      const feedback = await this.checkFeedbackFile(state, task);
      if (feedback) {
        task.feedback = feedback;

        // replan 类型的 feedback → 自动触发重规划 + 分级自治
        if (feedback.type === 'replan') {
          task.status = 'completed';
          task.completedAt = Date.now();
          await this.saveState(state);

          await this.notify(state.goalChannelId,
            `**Replan feedback:** ${this.getTaskLabel(state, task.id)} - ${task.description}\n` +
            `Reason: ${feedback.reason}`,
            'info'
          );

          // 先 merge 分支，再 replan（replan 需要基于已合并的代码状态）
          if (task.branchName) await this.mergeAndCleanup(state, task);

          // 触发重规划 + 分级自治
          await this.triggerReplan(state, task.id, feedback);

          // replan 后刷新 state 再继续调度
          const refreshed = await this.getState(goalId);
          if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
          return;
        }

        // 非 replan 类型 → 标记为 blocked_feedback 等待人工处理
        task.status = 'blocked_feedback';
        await this.saveState(state);
        await this.notify(state.goalChannelId,
          `**Feedback received:** ${this.getTaskLabel(state, task.id)} - ${task.description}\n` +
          `Type: ${feedback.type}\n` +
          `Reason: ${feedback.reason}` +
          (feedback.details ? `\nDetails: ${feedback.details}` : ''),
          'warning'
        );
        // blocked_feedback 后也经过审查层，让 reviewAndDispatch 处理路由
        if (state.status === 'running') await this.reviewAndDispatch(state);
        return;
      }

      task.status = 'completed';
      task.completedAt = Date.now();
      await this.saveState(state);

      const costInfo = usage ? ` ($${usage.total_cost_usd.toFixed(4)}, ${Math.round(usage.duration_ms / 1000)}s)` : '';
      await this.notify(state.goalChannelId, `Completed: ${this.getTaskLabel(state, task.id)} - ${task.description}${costInfo}`, 'success');

      // Brain eval 需要在 merge 前获取 diff stat（merge 后分支被删除）
      let preMergeDiffStat: string | undefined;
      if (task.type === '代码' && state.brainChannelId && task.branchName) {
        try {
          const goalDir = await this.getGoalWorktreeDir(state);
          if (goalDir) {
            const stat = await execGit(
              ['diff', '--stat', `${state.goalBranch}...${task.branchName}`],
              goalDir,
              `brain pre-merge diff stat for ${task.id}`,
            );
            preMergeDiffStat = stat.trim() || undefined;
          }
        } catch { /* ignore — best effort */ }
      }

      if (task.branchName) await this.mergeAndCleanup(state, task);

      // Post-task evaluation via Brain（代码任务 + 有 brain 时触发）
      if (task.type === '代码' && state.brainChannelId) {
        try {
          const ps = this.deps.promptService;
          const taskDiff = preMergeDiffStat ?? '(no diff available)';

          const evalPrompt = ps.render('orchestrator.brain_post_eval', {
            TASK_LABEL: this.getTaskLabel(state, task.id),
            TASK_DESCRIPTION: task.description,
            DIFF_STATS: taskDiff,
            TASK_ID: task.id,
          });
          await this.sendToBrain(state, evalPrompt);

          const evalResult = await this.readBrainDecision<{
            needsReplan: boolean; reason: string;
          }>(state, `eval-${task.id}.json`);

          if (evalResult?.needsReplan) {
            await this.notify(state.goalChannelId,
              `**Brain eval:** ${evalResult.reason}`,
              'info',
            );
            await this.triggerReplan(state, taskId, {
              type: 'replan',
              reason: `Post-task review: ${evalResult.reason}`,
            });
            const refreshed2 = await this.getState(goalId);
            if (refreshed2?.status === 'running') await this.reviewAndDispatch(refreshed2, taskId);
            return;
          }
        } catch (err: any) {
          logger.warn(`[Orchestrator] Brain post-eval failed, continuing: ${err.message}`);
        }
      }

      const refreshed = await this.getState(goalId);
      if (refreshed && refreshed.status === 'running') await this.reviewAndDispatch(refreshed, taskId);
    });
  }

  async onTaskFailed(goalId: string, taskId: string, error: string, usage?: ChatUsageResult): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'failed';
      task.error = error;

      // 写入 usage 数据（失败的 task 也记录已消耗的 token）
      if (usage) {
        task.tokensIn = usage.input_tokens;
        task.tokensOut = usage.output_tokens;
        task.cacheReadIn = usage.cache_read_input_tokens;
        task.cacheWriteIn = usage.cache_creation_input_tokens;
        task.costUsd = usage.total_cost_usd;
        task.durationMs = usage.duration_ms;
      }

      await this.saveState(state);

      const costInfo = usage ? ` ($${usage.total_cost_usd.toFixed(4)})` : '';
      const hasContext = !!task.channelId;

      // Brain failure analysis
      if (state.brainChannelId) {
        try {
          const ps = this.deps.promptService;
          const taskContext = hasContext
            ? `Has code context: yes (branch: ${task.branchName}, channel: ${task.channelId})`
            : 'Has code context: no';

          const failurePrompt = ps.render('orchestrator.brain_failure', {
            TASK_LABEL: this.getTaskLabel(state, task.id),
            TASK_DESCRIPTION: task.description,
            ERROR_MESSAGE: error,
            PIPELINE_PHASE: task.pipelinePhase ?? 'unknown',
            AUDIT_RETRIES: String(task.auditRetries ?? 0),
            TASK_CONTEXT: taskContext,
            TASK_ID: task.id,
          });
          await this.sendToBrain(state, failurePrompt);

          const analysis = await this.readBrainDecision<{
            recommendation: string; reason: string; confidence: string;
          }>(state, `failure-${task.id}.json`);

          if (analysis) {
            // 高置信度 retry + 未超限 → 自动重试
            if (analysis.confidence === 'high' && analysis.recommendation === 'retry'
                && (task.auditRetries ?? 0) < 3) {
              await this.notify(state.goalChannelId,
                `Failed: ${this.getTaskLabel(state, task.id)} - ${task.description}${costInfo}\n` +
                `Error: ${error}\n\n**Brain:** ${analysis.reason}\nAuto-retrying...`,
                'info',
              );
              // 重置 task 为 pending
              task.status = 'pending';
              task.error = undefined;
              task.branchName = undefined;
              task.channelId = undefined;
              task.dispatchedAt = undefined;
              task.pipelinePhase = undefined;
              task.auditRetries = (task.auditRetries ?? 0) + 1;
              await this.saveState(state);
              if (state.status === 'running') await this.reviewAndDispatch(state);
              return;
            }

            // 其他：Brain 推荐 + 增强按钮
            const buttons = buildFailureButtons(goalId, task.id, analysis.recommendation, hasContext);
            await this.notify(state.goalChannelId,
              `Failed: ${this.getTaskLabel(state, task.id)} - ${task.description}${costInfo}\n` +
              `Error: ${error}\n\n**Brain:** ${analysis.recommendation} (${analysis.confidence})\n${analysis.reason}`,
              'error',
              { components: buttons },
            );
            if (state.status === 'running') await this.reviewAndDispatch(state);
            return;
          }
        } catch (err: any) {
          logger.warn(`[Orchestrator] Brain failure analysis failed, using fallback: ${err.message}`);
        }
      }

      // Fallback: 原有按钮（无 brain 或 brain 失败时）
      const hint = hasContext
        ? `Reply "retry ${task.id}" to restart, or "refix ${task.id}" to fix in-place.`
        : `Reply "retry ${task.id}" to retry.`;
      const buttons = hasContext
        ? buildTaskFailedButtons(goalId, task.id)
        : undefined;
      await this.notify(state.goalChannelId,
        `Failed: ${this.getTaskLabel(state, task.id)} - ${task.description}${costInfo}\nError: ${error}\n\n${hint}`,
        'error',
        buttons ? { components: buttons } : undefined,
      );
      if (state.status === 'running') await this.reviewAndDispatch(state);
    });
  }

  // ========== Replan 分级自治 ==========

  /**
   * 触发重规划 + 分级自治流程
   *
   * 1. 收集已完成任务的 diff stats
   * 2. 调用 LLM 生成 replan 结果
   * 3. 根据 impact_level 自动执行或暂停等待审批
   */
  private async triggerReplan(
    state: GoalDriveState,
    triggerTaskId: string,
    feedback: GoalTaskFeedback,
  ): Promise<void> {
    try {
      // 1. 收集 diff stats
      const completedDiffStats = await collectCompletedDiffStats(state);

      // 2. 获取 Goal 元数据
      const goalMeta = await this.deps.goalMetaRepo.get(state.goalId);

      let result: ReplanResult | null = null;

      // 3a. 优先通过 Brain 重规划
      if (state.brainChannelId) {
        try {
          const ps = this.deps.promptService;
          const tasksSummary = state.tasks.map(t =>
            `- ${t.id}: [${t.type}] ${t.description} (${t.status})` +
            (t.depends.length > 0 ? ` depends: ${t.depends.join(', ')}` : ''),
          ).join('\n');
          const immutableCompleted = state.tasks
            .filter(t => t.status === 'completed' || t.status === 'skipped')
            .map(t => t.id).join(', ') || '(none)';
          const immutableRunning = state.tasks
            .filter(t => t.status === 'running' || t.status === 'dispatched')
            .map(t => t.id).join(', ') || '(none)';

          const replanPrompt = ps.render('orchestrator.brain_replan', {
            TRIGGER_TASK_ID: triggerTaskId,
            FEEDBACK_TYPE: feedback.type,
            FEEDBACK_REASON: feedback.reason,
            FEEDBACK_DETAILS: feedback.details ? `Details: ${feedback.details}` : '',
            CURRENT_TASKS: tasksSummary,
            IMMUTABLE_COMPLETED: immutableCompleted,
            IMMUTABLE_RUNNING: immutableRunning,
          });
          await this.sendToBrain(state, replanPrompt);
          result = await this.readBrainDecision<ReplanResult>(state, 'replan-result.json');
          if (result) {
            logger.info(`[Orchestrator] Brain replan succeeded`);
          }
        } catch (err: any) {
          logger.warn(`[Orchestrator] Brain replan failed, falling back to DeepSeek: ${err.message}`);
        }
      }

      // 3b. Fallback: DeepSeek replan
      if (!result) {
        const ctx: ReplanContext = {
          state,
          goalMeta,
          triggerTaskId,
          feedback,
          completedDiffStats,
          promptService: this.deps.promptService,
        };
        result = await replanTasks(ctx);
      }

      if (!result) {
        await this.notify(state.goalChannelId,
          `Replan 调用失败 — LLM 未返回有效结果，当前计划保持不变`,
          'warning',
        );
        return;
      }
      if (result.changes.length === 0) {
        await this.notify(state.goalChannelId,
          `Replan: 无需变更 — ${result.reasoning}`,
          'info',
        );
        return;
      }

      // 4. 分级自治处理
      const handleResult = await handleReplanByImpact(state, result, {
        taskRepo: this.deps.taskRepo,
        goalMetaRepo: this.deps.goalMetaRepo,
        checkpointRepo: this.deps.checkpointRepo,
        notify: (threadId, message, type, options) => this.notify(threadId, message, type, options),
      });

      if (handleResult.autoApplied) {
        logger.info(
          `[Orchestrator] Replan auto-applied (${handleResult.impactLevel}), goal ${state.goalId}`,
        );
      } else {
        logger.info(
          `[Orchestrator] Replan pending approval (high impact), goal ${state.goalId}`,
        );
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] triggerReplan failed: ${err.message}`);
      await this.notify(state.goalChannelId,
        `Replan 失败: ${err.message}`,
        'error',
      );
    }
  }

  /**
   * 用户审批 replan（approve replan）
   * 从 state.pendingReplan 读取待审批的变更并应用
   */
  async approveReplan(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;

    if (!state.pendingReplan) {
      await this.notify(state.goalChannelId, '没有待审批的计划变更', 'info');
      return false;
    }

    const pending = state.pendingReplan;

    // 应用变更
    const applyResult = await applyChanges(state, pending.changes as ReplanChange[], {
      taskRepo: this.deps.taskRepo,
      goalMetaRepo: this.deps.goalMetaRepo,
    });

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
      `✅ **计划变更已批准并执行**\n` +
      `已应用 ${applyResult.applied.length} 项变更` +
      (applyResult.rejected.length > 0
        ? `，${applyResult.rejected.length} 项被拒绝`
        : '') +
      `\n快照 ID: \`${pending.checkpointId}\``,
      'success',
      { components: buildReplanRollbackButton(goalId, pending.checkpointId) },
    );

    // 恢复调度（经过审查层，replan 后可能引入新占位任务）
    if (state.status === 'running') {
      await this.reviewAndDispatch(state);
    }

    return true;
  }

  /**
   * 获取待审批 replan 变更的 JSON 文本（用于预填 Modal）
   */
  async getPendingReplanChangesJson(goalId: string): Promise<string | null> {
    const state = await this.getState(goalId);
    if (!state?.pendingReplan) return null;
    return JSON.stringify(state.pendingReplan.changes, null, 2);
  }

  /**
   * 用户修改后批准 replan（approve with modifications）
   * 解析用户修改后的变更 JSON 并应用
   */
  async approveReplanWithModifications(
    goalId: string,
    modifiedChangesJson: string,
  ): Promise<{ success: boolean; applied: number; rejected: number; error?: string }> {
    const state = await this.getState(goalId);
    if (!state) return { success: false, applied: 0, rejected: 0, error: 'Goal not found' };

    if (!state.pendingReplan) {
      return { success: false, applied: 0, rejected: 0, error: '没有待审批的计划变更' };
    }

    // 解析用户修改后的 JSON
    let modifiedChanges: ReplanChange[];
    try {
      const parsed = JSON.parse(modifiedChangesJson);
      if (!Array.isArray(parsed)) {
        return { success: false, applied: 0, rejected: 0, error: 'JSON 必须是数组格式' };
      }
      modifiedChanges = parsed;
    } catch (err: any) {
      return { success: false, applied: 0, rejected: 0, error: `JSON 解析失败: ${err.message}` };
    }

    const pending = state.pendingReplan;

    // 应用修改后的变更
    const applyResult = await applyChanges(state, modifiedChanges, {
      taskRepo: this.deps.taskRepo,
      goalMetaRepo: this.deps.goalMetaRepo,
    });

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
      `✅ **修改后的计划已批准并执行**\n` +
      `已应用 ${applyResult.applied.length} 项变更` +
      (applyResult.rejected.length > 0
        ? `，${applyResult.rejected.length} 项被拒绝`
        : '') +
      `\n快照 ID: \`${pending.checkpointId}\``,
      'success',
      { components: buildReplanRollbackButton(goalId, pending.checkpointId) },
    );

    // 恢复调度
    if (state.status === 'running') {
      await this.reviewAndDispatch(state);
    }

    return {
      success: true,
      applied: applyResult.applied.length,
      rejected: applyResult.rejected.length,
    };
  }

  /**
   * 用户拒绝 replan（reject replan）
   * 丢弃待审批的变更，恢复调度
   */
  async rejectReplan(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;

    const pending = state.pendingReplan;
    if (!pending) {
      await this.notify(state.goalChannelId, '没有待审批的计划变更', 'info');
      return false;
    }

    // 清除 pending 状态
    delete state.pendingReplan;
    await this.saveState(state);

    await this.notify(state.goalChannelId,
      `🚫 **计划变更已拒绝**\n快照 ID: \`${pending.checkpointId}\``,
      'info',
    );

    // 恢复调度
    if (state.status === 'running') {
      await this.reviewAndDispatch(state);
    }

    return true;
  }

  // ========== 回滚流程 ==========

  /**
   * 回滚到指定检查点（第一阶段：评估）
   *
   * 1. 加载检查点，确定受影响的任务（在检查点之后 dispatch 的 running/dispatched/completed 任务）
   * 2. 立即 pause 所有受影响的 running 任务
   * 3. 评估成本（运行时间、git diff stat）
   * 4. 将评估结果发送给用户确认
   * 5. 存入 pendingRollback，等待 confirmRollback / cancelRollback
   *
   * @returns 成本评估结果（含 pendingRollback），null 表示失败
   */
  async rollback(goalId: string, checkpointId: string): Promise<PendingRollback | null> {
    return await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) {
        logger.error(`[Orchestrator] rollback: goal ${goalId} not found`);
        return null;
      }

      if (state.pendingRollback) {
        await this.notify(state.goalChannelId,
          `已有待确认的回滚操作（检查点: \`${state.pendingRollback.checkpointId}\`）\n` +
          `请先 \`confirm rollback\` 或 \`cancel rollback\``,
          'warning',
        );
        return null;
      }

      // 1. 加载检查点
      const checkpoint = await this.deps.checkpointRepo.get(checkpointId);
      if (!checkpoint) {
        await this.notify(state.goalChannelId, `检查点 \`${checkpointId}\` 不存在`, 'error');
        return null;
      }
      if (checkpoint.goalId !== goalId) {
        await this.notify(state.goalChannelId, `检查点 \`${checkpointId}\` 不属于此 Goal`, 'error');
        return null;
      }
      if (!checkpoint.tasksSnapshot) {
        await this.notify(state.goalChannelId, `检查点 \`${checkpointId}\` 没有任务快照`, 'error');
        return null;
      }

      // 2. 确定受影响的任务：快照中不存在 或 快照中状态不是 completed/merged 但现在有进展的任务
      const snapshotTaskIds = new Set(checkpoint.tasksSnapshot.map(t => t.id));
      const snapshotTaskMap = new Map(checkpoint.tasksSnapshot.map(t => [t.id, t]));

      const affectedTasks: PendingRollback['affectedTasks'] = [];
      const pausedTaskIds: string[] = [];

      for (const task of state.tasks) {
        // 快照中不存在的任务（replan 后新增的）→ 受影响
        if (!snapshotTaskIds.has(task.id)) {
          if (task.status === 'running' || task.status === 'dispatched' ||
              task.status === 'completed' || task.status === 'paused') {
            affectedTasks.push({
              id: task.id,
              description: task.description,
              previousStatus: task.status,
              runtime: task.dispatchedAt ? Date.now() - task.dispatchedAt : undefined,
            });
          }
          continue;
        }

        // 快照中存在的任务：比较状态变化
        const snapshotTask = snapshotTaskMap.get(task.id)!;
        const statusChanged = task.status !== snapshotTask.status;
        const hasProgress = (
          task.status === 'running' || task.status === 'dispatched' ||
          (task.status === 'completed' && snapshotTask.status !== 'completed')
        );

        if (statusChanged && hasProgress) {
          affectedTasks.push({
            id: task.id,
            description: task.description,
            previousStatus: task.status,
            runtime: task.dispatchedAt ? Date.now() - task.dispatchedAt : undefined,
          });
        }
      }

      // 3. Pause 所有正在运行的受影响任务
      const guildId = this.getGuildId();
      for (const affected of affectedTasks) {
        const task = state.tasks.find(t => t.id === affected.id);
        if (!task) continue;

        if (task.status === 'running') {
          // 中止 Claude 进程
          if (task.channelId && guildId) {
            const lockKey = StateManager.channelLockKey(guildId, task.channelId);
            this.deps.claudeClient.abort(lockKey);
          }
          task.status = 'paused';
          pausedTaskIds.push(task.id);
        } else if (task.status === 'dispatched') {
          task.status = 'paused';
          pausedTaskIds.push(task.id);
        }
      }

      // 4. 收集 git diff stats（评估代码产出量）
      const worktreeListOutput = await this.safeListWorktrees(state.baseCwd);
      for (const affected of affectedTasks) {
        const task = state.tasks.find(t => t.id === affected.id);
        if (!task?.branchName || !worktreeListOutput) continue;

        try {
          const goalWorktreeDir = this.findWorktreeDir(worktreeListOutput, state.goalBranch);
          if (goalWorktreeDir) {
            const diffStat = await execGit(
              ['diff', '--stat', `${state.goalBranch}...${task.branchName}`],
              goalWorktreeDir,
              `rollback: diff stat for ${task.id}`,
            );
            if (diffStat.trim()) {
              affected.diffStat = diffStat.trim();
            }
          }
        } catch {
          // diff stat 失败不阻塞回滚流程
        }
      }

      // 5. 生成成本摘要
      const costSummary = this.buildRollbackCostSummary(affectedTasks, checkpoint);

      // 6. 构建 PendingRollback 并存入 state
      const pendingRollback: PendingRollback = {
        checkpointId,
        pausedTaskIds,
        costSummary,
        affectedTasks,
        createdAt: Date.now(),
      };

      state.pendingRollback = pendingRollback;
      await this.saveState(state);

      // 7. 通知用户确认（含确认/取消按钮）
      const confirmMessage =
        `⏪ **回滚评估：检查点 \`${checkpointId}\`**\n\n` +
        costSummary;

      await this.notify(state.goalChannelId, confirmMessage, 'warning', {
        components: buildRollbackConfirmButtons(goalId),
      });

      return pendingRollback;
    });
  }

  /**
   * 确认回滚（第二阶段：执行）
   *
   * 1. stop 所有受影响任务的进程
   * 2. restoreCheckpoint 恢复任务计划
   * 3. git reset goal 分支到检查点 commit
   * 4. 清理受影响任务的 worktree/分支/Discord channel
   * 5. 恢复调度
   */
  async confirmRollback(goalId: string): Promise<boolean> {
    return await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return false;

      const pending = state.pendingRollback;
      if (!pending) {
        await this.notify(state.goalChannelId, '没有待确认的回滚操作', 'info');
        return false;
      }

      const guildId = this.getGuildId();

      // 1. 恢复检查点的任务快照
      const snapshotTasks = await this.deps.checkpointRepo.restoreCheckpoint(pending.checkpointId);
      if (!snapshotTasks) {
        await this.notify(state.goalChannelId,
          `回滚失败：检查点 \`${pending.checkpointId}\` 快照数据不可用`,
          'error',
        );
        delete state.pendingRollback;
        await this.saveState(state);
        return false;
      }

      // 2. 收集需要清理的任务（当前 state 中有 branch/thread 但快照中不存在或状态不同的任务）
      const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));
      const tasksToCleanup: GoalTask[] = [];

      for (const task of state.tasks) {
        const snapshotTask = snapshotTaskMap.get(task.id);

        // 任务在快照中不存在（replan 新增的）→ 需要清理
        if (!snapshotTask) {
          if (task.branchName || task.channelId) {
            tasksToCleanup.push(task);
          }
          continue;
        }

        // 任务在快照中是 pending 但现在有 branch/thread → 需要清理
        if (snapshotTask.status === 'pending' && (task.branchName || task.channelId)) {
          tasksToCleanup.push(task);
        }
      }

      // 3. 清理受影响任务的资源（stop 进程 + 删除 worktree/分支 + 删除 Discord channel）
      const worktreeListOutput = await this.safeListWorktrees(state.baseCwd);

      for (const task of tasksToCleanup) {
        // 停止进程
        if (task.channelId && guildId) {
          const lockKey = StateManager.channelLockKey(guildId, task.channelId);
          this.deps.claudeClient.abort(lockKey);
        }

        // 清理 worktree 和分支
        if (task.branchName && worktreeListOutput) {
          const subtaskDir = this.findWorktreeDir(worktreeListOutput, task.branchName);
          if (subtaskDir) {
            try {
              await cleanupSubtask(state.baseCwd, subtaskDir, task.branchName);
            } catch (err: any) {
              logger.warn(`[Orchestrator] rollback: cleanup failed for ${task.id}: ${err.message}`);
            }
          } else {
            // worktree 可能已不存在，尝试只删除分支
            try {
              await execGit(['branch', '-D', task.branchName], state.baseCwd,
                `rollback: force delete branch ${task.branchName}`);
            } catch { /* ignore */ }
          }
        }

        // 删除 Discord channel
        if (task.channelId) {
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'rollback');
          }
          try {
            const channel = await this.deps.client.channels.fetch(task.channelId);
            if (channel && 'delete' in channel) {
              await (channel as any).delete('Rolled back').catch(() => {});
            }
          } catch { /* ignore */ }
        }
      }

      // 4. Git reset goal 分支到检查点 commit（如果检查点有 gitRef）
      const checkpoint = await this.deps.checkpointRepo.get(pending.checkpointId);
      if (checkpoint?.gitRef && worktreeListOutput) {
        const goalWorktreeDir = this.findWorktreeDir(worktreeListOutput, state.goalBranch);
        if (goalWorktreeDir) {
          try {
            await execGit(['reset', '--hard', checkpoint.gitRef], goalWorktreeDir,
              `rollback: reset goal branch to ${checkpoint.gitRef}`);
            logger.info(`[Orchestrator] rollback: reset ${state.goalBranch} to ${checkpoint.gitRef}`);
          } catch (err: any) {
            logger.warn(`[Orchestrator] rollback: git reset failed: ${err.message}`);
            await this.notify(state.goalChannelId,
              `Git reset 失败: ${err.message}\n任务计划已恢复，但 git 历史可能需要手动处理`,
              'warning',
            );
          }
        }
      }

      // 5. 恢复任务列表
      state.tasks = snapshotTasks;
      delete state.pendingRollback;

      // 确保 goal 状态可恢复调度
      if (state.status === 'paused') {
        state.status = 'running';
      }

      // 持久化
      await this.deps.taskRepo.saveAll(snapshotTasks, state.goalId);
      await this.saveState(state);

      // 更新 Goal body
      const goalMeta = await this.deps.goalMetaRepo.get(state.goalId);
      if (goalMeta) {
        goalMeta.body = updateGoalBodyWithTasks(goalMeta.body, snapshotTasks);
        const completed = snapshotTasks.filter(t => t.status === 'completed').length;
        const active = snapshotTasks.filter(t => t.status !== 'cancelled' && t.status !== 'skipped').length;
        goalMeta.progress = `${completed}/${active} 子任务完成`;
        await this.deps.goalMetaRepo.save(goalMeta);
      }

      const cleanedCount = tasksToCleanup.length;
      await this.notify(state.goalChannelId,
        `✅ **回滚完成**\n` +
        `已恢复到检查点 \`${pending.checkpointId}\`\n` +
        `清理了 ${cleanedCount} 个受影响任务的资源\n` +
        `任务计划已恢复，继续调度...`,
        'success',
      );

      // 6. 恢复调度
      if (state.status === 'running') {
        await this.reviewAndDispatch(state);
      }

      return true;
    });
  }

  /**
   * 取消回滚：恢复已暂停的任务
   */
  async cancelRollback(goalId: string): Promise<boolean> {
    return await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return false;

      const pending = state.pendingRollback;
      if (!pending) {
        await this.notify(state.goalChannelId, '没有待确认的回滚操作', 'info');
        return false;
      }

      const guildId = this.getGuildId();

      // 恢复被暂停的任务
      for (const taskId of pending.pausedTaskIds) {
        const task = state.tasks.find(t => t.id === taskId);
        if (!task || task.status !== 'paused') continue;

        // 找回原始状态
        const affected = pending.affectedTasks.find(a => a.id === taskId);
        if (affected && (affected.previousStatus === 'running' || affected.previousStatus === 'dispatched')) {
          // 重新设为 pending 让调度器重新分发
          task.status = 'pending';
          task.branchName = undefined;
          task.channelId = undefined;
          task.dispatchedAt = undefined;
        }
      }

      delete state.pendingRollback;
      await this.saveState(state);

      await this.notify(state.goalChannelId,
        `🚫 **回滚已取消**\n已暂停的任务将重新派发（之前的执行进度无法恢复）`,
        'info',
      );

      // 恢复调度
      if (state.status === 'running') {
        await this.reviewAndDispatch(state);
      }

      return true;
    });
  }

  /**
   * 生成回滚成本评估摘要
   */
  private buildRollbackCostSummary(
    affectedTasks: PendingRollback['affectedTasks'],
    checkpoint: import('../types/index.js').GoalCheckpoint,
  ): string {
    const lines: string[] = [];

    const checkpointAge = Date.now() - checkpoint.createdAt;
    const ageMinutes = Math.floor(checkpointAge / 60_000);
    const ageStr = ageMinutes < 60
      ? `${ageMinutes} 分钟前`
      : `${Math.floor(ageMinutes / 60)} 小时 ${ageMinutes % 60} 分钟前`;

    lines.push(`**检查点信息**`);
    lines.push(`- 创建时间: ${ageStr}`);
    lines.push(`- 触发: ${checkpoint.trigger}`);
    if (checkpoint.reason) {
      lines.push(`- 原因: ${checkpoint.reason}`);
    }
    lines.push('');

    if (affectedTasks.length === 0) {
      lines.push('**无受影响任务** — 回滚仅恢复任务计划');
      return lines.join('\n');
    }

    lines.push(`**受影响任务 (${affectedTasks.length} 个):**`);
    for (const task of affectedTasks) {
      const runtimeStr = task.runtime
        ? ` (运行 ${Math.floor(task.runtime / 60_000)} 分钟)`
        : '';
      const diffStr = task.diffStat
        ? `\n  \`\`\`\n  ${task.diffStat.split('\n').slice(-1)[0]}\n  \`\`\``
        : '';
      lines.push(`- **${task.id}** [${task.previousStatus}] ${task.description}${runtimeStr}${diffStr}`);
    }

    // 汇总
    const totalRuntime = affectedTasks.reduce((sum, t) => sum + (t.runtime || 0), 0);
    if (totalRuntime > 0) {
      lines.push('');
      lines.push(`**总计运行时间:** ${Math.floor(totalRuntime / 60_000)} 分钟`);
    }

    return lines.join('\n');
  }

  /**
   * 安全获取 worktree 列表，失败返回 null
   */
  private async safeListWorktrees(baseCwd: string): Promise<string | null> {
    try {
      return await execGit(
        ['worktree', 'list', '--porcelain'],
        baseCwd,
        'rollback: list worktrees',
      );
    } catch {
      return null;
    }
  }

  // ========== Feedback 检测 ==========

  /**
   * 检测子任务 worktree 下的 feedback/<taskId>.json
   * 存在且合法则返回 feedback 内容，否则返回 null
   */
  private async checkFeedbackFile(state: GoalDriveState, task: GoalTask): Promise<GoalTaskFeedback | null> {
    if (!task.branchName) return null;

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `checkFeedbackFile(${task.id}): list worktrees`
      );
      const subtaskDir = this.findWorktreeDir(stdout, task.branchName);
      if (!subtaskDir) return null;

      const feedbackPath = join(subtaskDir, 'feedback', `${task.id}.json`);
      const content = await readFile(feedbackPath, 'utf-8');
      const parsed = JSON.parse(content);

      // 校验必须字段
      if (!parsed.type || !parsed.reason) {
        logger.warn(`[Orchestrator] Invalid feedback file for ${task.id}: missing type or reason`);
        return null;
      }

      return {
        type: parsed.type,
        reason: parsed.reason,
        details: parsed.details,
      };
    } catch {
      // 文件不存在或读取/解析失败 → 无 feedback
      return null;
    }
  }

  private async mergeAndCleanup(state: GoalDriveState, task: GoalTask): Promise<void> {
    if (!task.branchName) return;

    // Per-goal merge lock: queue merges for the same goal, allow different goals concurrently
    const goalId = state.goalId;
    const prev = this.mergeLocks.get(goalId) || Promise.resolve();
    const current = prev.then(() => this.doMergeAndCleanup(state, task)).catch(() => {});
    this.mergeLocks.set(goalId, current);
    await current;
  }

  private async doMergeAndCleanup(state: GoalDriveState, task: GoalTask): Promise<void> {
    if (!task.branchName) return;
    const branchName = task.branchName;

    try {
      const stdout = await execGit(
        ['worktree', 'list', '--porcelain'],
        state.baseCwd,
        `mergeAndCleanup(${branchName}): list worktrees`
      );
      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        await this.notify(state.goalChannelId, `Cannot find goal worktree, skipping merge: ${branchName}`, 'warning');
        return;
      }

      const subtaskDir = this.findWorktreeDir(stdout, branchName);
      if (subtaskDir) {
        const hasChanges = await hasUncommittedChanges(subtaskDir);
        if (hasChanges) {
          await autoCommit(subtaskDir, `auto: ${task.description}`);
        }
      }

      const result = await mergeSubtaskBranch(goalWorktreeDir, branchName);

      if (result.success) {
        task.merged = true;
        await this.saveState(state);
        await this.notify(state.goalChannelId, `Merged: \`${branchName}\` → \`${state.goalBranch}\``, 'success');

        if (subtaskDir) {
          await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
        }

        // Delete subtask channel
        if (task.channelId) {
          const guildId = this.getGuildId();
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'merged');
            try {
              const channel = await this.deps.client.channels.fetch(task.channelId);
              if (channel && 'delete' in channel) {
                await (channel as any).delete('Task merged and cleaned up').catch(() => {});
              }
            } catch { /* ignore */ }
          }
        }
      } else if (result.conflict) {
        // 尝试 AI 自动解决冲突
        await this.notify(state.goalChannelId,
          `Merge conflict: \`${branchName}\` → \`${state.goalBranch}\`, trying AI resolution...`,
          'warning'
        );

        const resolution = await resolveConflictsWithAI(
          this.deps.claudeClient,
          goalWorktreeDir,
          branchName,
          task.description,
          this.deps.promptService,
        );

        if (resolution.resolved) {
          task.merged = true;
          await this.saveState(state);
          await this.notify(state.goalChannelId,
            `AI resolved conflict and merged: \`${branchName}\` → \`${state.goalBranch}\``,
            'success'
          );

          if (subtaskDir) {
            await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
          }

          if (task.channelId) {
            const guildId = this.getGuildId();
            if (guildId) {
              this.deps.stateManager.archiveSession(guildId, task.channelId, undefined, 'merged');
              try {
                const channel = await this.deps.client.channels.fetch(task.channelId);
                if (channel && 'delete' in channel) {
                  await (channel as any).delete('Task merged and cleaned up').catch(() => {});
                }
              } catch { /* ignore */ }
            }
          }
        } else {
          // AI 无法解决，fallback 到人工干预
          await this.notify(state.goalChannelId,
            `AI could not resolve conflict: \`${branchName}\` → \`${state.goalBranch}\`\n` +
            `Reason: ${resolution.error}\n` +
            `Manual resolution needed. Reply "done ${task.id}" when resolved.`,  // keep task.id for command matching
            'error'
          );
          task.status = 'blocked';
          task.error = 'merge conflict (AI resolution failed)';
          await this.saveState(state);
        }
      } else {
        await this.notify(state.goalChannelId, `Merge failed: ${branchName}\nError: ${result.error}`, 'error');
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] mergeAndCleanup error: ${err.message}`);
    }
  }

  private async generateBranchName(task: GoalTask, state: GoalDriveState): Promise<string> {
    const prefix = task.type === '调研' ? 'research' : 'feat';
    const translated = await translateToBranchName(task.description);
    const taskLabel = this.getTaskLabel(state, task.id);
    return `${prefix}/${taskLabel}-${translated.slice(0, 30) || 'task'}`;
  }

  private buildTaskPrompt(task: GoalTask, state: GoalDriveState): string {
    const ps = this.deps.promptService;
    const label = this.getTaskLabel(state, task.id);
    const parts: string[] = [];

    // 主模板
    parts.push(ps.render('orchestrator.task', {
      GOAL_NAME: state.goalName,
      TASK_LABEL: label,
      TASK_TYPE: task.type,
      TASK_DESCRIPTION: task.description,
    }));

    // 条件 section：详细计划
    if (task.detailPlan) {
      const s = ps.tryRender('orchestrator.task.detail_plan', {
        DETAIL_PLAN_TEXT: task.detailPlan,
      });
      if (s) parts.push(s);
    }

    // 条件 section：依赖
    if (task.depends.length > 0) {
      const depList = task.depends.map(depId => {
        const dep = state.tasks.find(t => t.id === depId);
        return dep ? `  - ${this.getTaskLabel(state, dep.id)}: ${dep.description} (${dep.status})` : `  - ${depId}: (unknown)`;
      }).join('\n');
      const s = ps.tryRender('orchestrator.task.dependencies', { DEP_LIST: depList });
      if (s) parts.push(s);
    }

    // 固定 sections（tryRender 容错）
    const req = ps.tryRender('orchestrator.task.requirements', {});
    if (req) parts.push(req);
    const fb = ps.tryRender('orchestrator.task.feedback_protocol', { TASK_ID: task.id });
    if (fb) parts.push(fb);

    // 条件 section：调研任务
    if (task.type === '调研') {
      const s = ps.tryRender('orchestrator.task.research_rules', { TASK_ID: task.id });
      if (s) parts.push(s);
    }

    const wf = ps.tryRender('orchestrator.task.when_to_feedback', {});
    if (wf) parts.push(wf);

    // 条件 section：占位任务
    if (task.type === '占位') {
      const s = ps.tryRender('orchestrator.task.placeholder_rules', {});
      if (s) parts.push(s);
    }

    return parts.join('\n\n');
  }

  private findWorktreeDir(worktreeListOutput: string, branchName: string): string | null {
    const lines = worktreeListOutput.split('\n');
    let currentWorktree = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentWorktree = line.slice('worktree '.length);
      }
      if (line.startsWith('branch ') && line.includes(branchName)) {
        return currentWorktree;
      }
    }
    return null;
  }

  /**
   * 发送通知到 goal thread 和/或日志 channel
   *
   * type 说明：
   * - success/error/warning/info: 发到 goal thread（同时也发日志 channel）
   * - pipeline: 仅发到日志 channel（如未配置则 fallback 到 goal thread）
   *
   * 颜色映射：
   * - success → GREEN, error → RED, warning → YELLOW, info → GRAY, pipeline → BLUE
   */
  private async notify(
    threadId: string,
    message: string,
    type?: 'success' | 'error' | 'warning' | 'info' | 'pipeline',
    options?: { components?: import('discord.js').ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>[] },
  ): Promise<void> {
    try {
      const colorMap: Record<string, EmbedColor> = {
        success: EmbedColors.GREEN,
        error: EmbedColors.RED,
        warning: EmbedColors.YELLOW,
        info: EmbedColors.GRAY,
        pipeline: EmbedColors.BLUE,
      };
      const embedColor = type ? colorMap[type] : undefined;
      const logChannelId = getGoalLogChannelId();

      if (type === 'pipeline') {
        // pipeline 类型：仅发日志 channel（未配置则 fallback 到 goal thread）
        const targetId = logChannelId || threadId;
        await this.deps.mq.sendLong(targetId, message, {
          embedColor,
          components: options?.components,
        });
      } else {
        // 其他类型：发到 goal thread
        await this.deps.mq.sendLong(threadId, message, {
          embedColor,
          components: options?.components,
        });
        // 同时发到日志 channel（如已配置，且目标不同）
        if (logChannelId && logChannelId !== threadId) {
          await this.deps.mq.sendLong(logChannelId, message, {
            embedColor,
            silent: true,
          });
        }
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] Failed to send notification: ${err.message}`);
    }
  }

  private getGuildId(): string | null {
    return getAuthorizedGuildId() ?? null;
  }

  /**
   * 检查 Goal task 完成准备状态（Stop hook 触发）
   * 向 Claude 发送 3 个检查问题，根据回答自动推进 pipeline
   */
  async checkTaskReadiness(goalId: string, taskId: string, channelId: string): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;

      const task = state.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'running') {
        logger.debug(`[Orchestrator] checkTaskReadiness: task ${taskId} not in running state, skip`);
        return;
      }

      logger.info(`[Orchestrator] Auto-checking task readiness: ${this.getTaskLabel(state, taskId)}`);

      // 构建检查 prompt
      const phase = task.pipelinePhase || 'execute';
      const checkPrompt = this.buildReadinessCheckPrompt(task, state, phase);

      if (!checkPrompt) {
        logger.warn(`[Orchestrator] Prompt not found for phase ${phase}, skip auto-check`);
        return;
      }

      // 向 Claude 发送检查问题（在当前 session 中）
      const guildId = this.getGuildId();
      if (!guildId) {
        logger.warn(`[Orchestrator] No authorized guild, skip auto-check`);
        return;
      }

      try {
        const usage = await this.deps.messageHandler.handleBackgroundChat(
          guildId,
          channelId,
          checkPrompt
        );

        // 读取 Claude 的回答（从 transcript 或最后一条消息）
        const response = await this.readTaskCheckResponse(channelId, state, task);

        if (!response) {
          logger.warn(`[Orchestrator] Failed to parse check response, skip auto-advance`);
          return;
        }

        await this.handleTaskCheckResponse(goalId, taskId, response, state, usage);
      } catch (err: any) {
        logger.error(`[Orchestrator] checkTaskReadiness failed:`, err.message);

        // 标记任务失败（避免任务永久卡在 running 状态）
        await this.onTaskFailed(
          goalId,
          taskId,
          `Auto-check failed: ${err.message}`
        );
      }
    });
  }

  /**
   * 构建任务完成检查 prompt
   */
  private buildReadinessCheckPrompt(
    task: GoalTask,
    state: GoalDriveState,
    phase: string
  ): string | null {
    const ps = this.deps.promptService;
    const promptKey = `orchestrator.task_readiness_check.${phase}`;

    return ps.tryRender(promptKey, {
      TASK_DESCRIPTION: task.description,
      TASK_ID: task.id,
      TASK_LABEL: this.getTaskLabel(state, task.id),
      PIPELINE_PHASE: phase,
    });
  }

  /**
   * 读取任务检查回答（从 channel 的最后一条 Claude 消息）
   */
  private async readTaskCheckResponse(
    channelId: string,
    state: GoalDriveState,
    task: GoalTask
  ): Promise<{ completed: boolean; audited: boolean; committed: boolean } | null> {
    try {
      // 方法1: 尝试从 feedback 文件读取（如果 Claude 写入了结构化反馈）
      const feedbackPath = join(state.baseCwd, 'feedback', `${task.id}-readiness.json`);
      try {
        const feedbackContent = await readFile(feedbackPath, 'utf-8');
        const feedback = JSON.parse(feedbackContent);
        if (feedback.completed !== undefined && feedback.audited !== undefined && feedback.committed !== undefined) {
          logger.info(`[Orchestrator] Read readiness check from feedback file`);
          return feedback;
        }
      } catch {
        // Feedback 文件不存在，继续尝试其他方法
      }

      // 方法2: 从 Discord channel 读取最后一条 Claude 消息
      const channel = await this.deps.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return null;

      const messages = await channel.messages.fetch({ limit: 5 });
      const botMessages = messages.filter(m => m.author.id === this.deps.client.user?.id);
      if (botMessages.size === 0) return null;

      const lastBotMessage = botMessages.first();
      if (!lastBotMessage) return null;

      // 解析回答
      return this.parseCheckResponse(lastBotMessage.content);
    } catch (err: any) {
      logger.error(`[Orchestrator] Failed to read check response:`, err.message);
      return null;
    }
  }

  /**
   * 解析检查回答文本
   */
  private parseCheckResponse(text: string): {
    completed: boolean;
    audited: boolean;
    committed: boolean;
  } | null {
    // 尝试提取代码块中的答案
    const codeBlockMatch = text.match(/```(?:\w+)?\s*\n([\s\S]*?)\n```/);
    let lines: string[];

    if (codeBlockMatch) {
      lines = codeBlockMatch[1].split('\n');
    } else {
      lines = text.split('\n');
    }

    // 提取 yes/no 答案
    const answers = lines
      .map(l => {
        const match = l.match(/\d+\.\s*(yes|no)/i);
        return match ? match[1].toLowerCase() === 'yes' : null;
      })
      .filter(a => a !== null) as boolean[];

    if (answers.length !== 3) {
      logger.debug(`[Orchestrator] Expected 3 answers, got ${answers.length}`);
      return null;
    }

    return {
      completed: answers[0],
      audited: answers[1],
      committed: answers[2],
    };
  }

  /**
   * 处理任务检查回答
   */
  private async handleTaskCheckResponse(
    goalId: string,
    taskId: string,
    response: { completed: boolean; audited: boolean; committed: boolean },
    state: GoalDriveState,
    usage?: ChatUsageResult
  ): Promise<void> {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    const { completed, audited, committed } = response;

    // 全部通过 → 自动推进到下一阶段
    if (completed && audited && committed) {
      const currentPhase = task.pipelinePhase || 'execute';

      logger.info(`[Orchestrator] Task ${taskId} passed auto-check, advancing from ${currentPhase}`);

      if (currentPhase === 'execute') {
        // Execute 阶段完成 → 推进到 audit
        task.pipelinePhase = 'audit';
        task.status = 'dispatched';
        await this.saveState(state);

        await this.notify(
          state.goalChannelId,
          `✅ **任务自检通过，推进到 Audit 阶段:** ${this.getTaskLabel(state, taskId)} - ${task.description}`,
          'pipeline'
        );

        // 启动 audit 流程（如果是多模型流水线）
        if (task.complexity === 'complex') {
          // Complex task → 启动 Opus audit
          const guildId = this.getGuildId();
          if (guildId && task.channelId) {
            await this.startAuditPipeline(goalId, taskId, guildId, task.channelId, usage);
          }
        } else {
          // Simple task → 直接完成
          await this.onTaskCompleted(goalId, taskId, usage);
        }
      } else if (currentPhase === 'audit') {
        // Audit 阶段完成 → 标记为 completed
        await this.onTaskCompleted(goalId, taskId, usage);
      } else if (currentPhase === 'fix') {
        // Fix 阶段完成 → 推进到 re-audit
        await this.notify(
          state.goalChannelId,
          `✅ **修复完成，准备重新审查:** ${this.getTaskLabel(state, taskId)}`,
          'pipeline'
        );
        // Re-audit 逻辑已在 auditFixLoop 中处理
      }
    } else {
      // 有未通过项 → Claude 应该已经在回答中说明了原因，继续等待它完成
      logger.info(`[Orchestrator] Task ${taskId} auto-check failed, waiting for completion`);

      // 记录未通过的检查项到 task metadata（用于调试）
      const issues: string[] = [];
      if (!completed) issues.push('任务未完成');
      if (!audited) issues.push('审查未通过');
      if (!committed) issues.push('未提交代码');

      task.metadata = {
        ...task.metadata,
        lastCheckFailed: Date.now(),
        lastCheckIssues: issues,
      };
      await this.saveState(state);

      // 不发送通知，让 Claude 自己继续工作
    }
  }

  /**
   * 启动 Audit pipeline（从 execute 阶段推进时调用）
   */
  private async startAuditPipeline(
    goalId: string,
    taskId: string,
    guildId: string,
    channelId: string,
    prevUsage?: ChatUsageResult
  ): Promise<void> {
    const state = await this.getState(goalId);
    if (!state) return;

    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    // 切换到 Opus model 进行 audit
    const { pipelineOpusModel: opusModel } = this.deps.config;
    this.switchSessionModel(guildId, channelId, opusModel, 'audit');
    task.pipelinePhase = 'audit';
    task.status = 'running';
    await this.saveState(state);

    await this.notify(
      state.goalChannelId,
      `[Pipeline] ${taskId}: 进入 Opus Audit 阶段`,
      'pipeline'
    );

    // 启动完整的 pipeline 流程（包含 audit）
    const usage: ChatUsageResult = prevUsage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0,
      duration_ms: 0,
    };

    // TODO: 实现 audit pipeline 逻辑
    // Audit pipeline 应该切换到 Opus model 并发送 audit prompt
    logger.warn(`[Orchestrator] startAuditPipeline: audit pipeline not fully implemented yet`);
  }
}
