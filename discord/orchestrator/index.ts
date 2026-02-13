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
import type { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import { type MessageQueue, EmbedColors, type EmbedColor } from '../bot/message-queue.js';
import type { DiscordBotConfig, GoalDriveState, GoalTask } from '../types/index.js';
import type { IGoalRepo } from '../types/repository.js';
import { stat } from 'fs/promises';
import { getAuthorizedGuildId } from '../utils/env.js';
import { generateTopicTitle } from '../utils/llm.js';
import { execGit, resolveMainWorktree } from './git-ops.js';
import { parseTasks, goalNameToBranch, translateToBranchName } from './goal-state.js';
import { getNextBatch, isGoalComplete, isGoalStuck, getProgressSummary } from './task-scheduler.js';
import {
  createGoalBranch,
  createSubtaskBranch,
  mergeSubtaskBranch,
  cleanupSubtask,
  hasUncommittedChanges,
  autoCommit,
} from './goal-branch.js';
import { logger } from '../utils/logger.js';

interface OrchestratorDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  messageHandler: MessageHandler;
  client: Client;
  mq: MessageQueue;
  config: DiscordBotConfig;
  goalRepo: IGoalRepo;
}

/** startDrive 的入参 */
export interface StartDriveParams {
  goalId: string;
  goalName: string;
  goalThreadId: string;
  baseCwd: string;
  tasks: Array<{
    id: string;
    description: string;
    type?: string;
    depends?: string[];
    phase?: number;
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

  /** 启动 Goal 自动推进 */
  async startDrive(params: StartDriveParams): Promise<GoalDriveState> {
    const { goalId, goalName, goalThreadId, baseCwd: inputCwd, tasks: rawTasks, maxConcurrent = 3 } = params;

    const existing = this.activeDrives.get(goalId) || await this.deps.goalRepo.get(goalId);
    if (existing && (existing.status === 'running' || existing.status === 'paused')) {
      const hint = existing.status === 'paused' ? ' Use resumeDrive to continue.' : '';
      await this.notify(goalThreadId, `Goal "${goalName}" is already ${existing.status}.${hint}`, 'info');
      return existing;
    }

    let baseCwd: string;
    try {
      baseCwd = await resolveMainWorktree(inputCwd);
      if (baseCwd !== inputCwd) {
        logger.info(`[Orchestrator] Normalized baseCwd: ${inputCwd} → ${baseCwd}`);
      }
    } catch (err: any) {
      await this.notify(goalThreadId, `Invalid working directory: ${inputCwd}\nError: ${err.message}`, 'error');
      throw err;
    }

    const goalBranch = await goalNameToBranch(goalName);

    let goalWorktreeDir: string;
    try {
      goalWorktreeDir = await createGoalBranch(baseCwd, goalBranch, this.deps.config.worktreesDir);
    } catch (err: any) {
      await this.notify(goalThreadId, `Failed to create goal branch: ${err.message}`, 'error');
      throw err;
    }

    const state: GoalDriveState = {
      goalId,
      goalName,
      goalBranch,
      goalThreadId,
      baseCwd,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxConcurrent,
      tasks: parseTasks(rawTasks),
    };

    await this.saveState(state);
    this.activeDrives.set(goalId, state);

    await this.notify(goalThreadId,
      `**Goal Drive started:** ${goalName}\n` +
      `Branch: \`${goalBranch}\`\n` +
      `Tasks: ${state.tasks.length}\n` +
      `Max concurrent: ${maxConcurrent}`,
      'success'
    );

    await this.dispatchNext(state);
    return state;
  }

  async pauseDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'running') return false;
    state.status = 'paused';
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Goal "${state.goalName}" paused`, 'warning');
    return true;
  }

  async resumeDrive(goalId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state || state.status !== 'paused') return false;
    state.status = 'running';
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Goal "${state.goalName}" resumed`, 'success');
    await this.dispatchNext(state);
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
    if (task.status !== 'pending' && task.status !== 'blocked' && task.status !== 'failed') return false;
    task.status = 'skipped';
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Skipped task: ${task.id} - ${task.description}`, 'info');
    if (state.status === 'running') await this.dispatchNext(state);
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
    await this.notify(state.goalThreadId, `Manual task completed: ${task.id} - ${task.description}`, 'success');
    if (state.status === 'running') await this.dispatchNext(state);
    return true;
  }

  async retryTask(goalId: string, taskId: string): Promise<boolean> {
    const state = await this.getState(goalId);
    if (!state) return false;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'failed') return false;
    task.status = 'pending';
    task.error = undefined;
    task.branchName = undefined;
    task.threadId = undefined;
    task.dispatchedAt = undefined;
    task.merged = false;
    await this.saveState(state);
    await this.notify(state.goalThreadId, `Retrying task: ${task.id} - ${task.description}`, 'warning');
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
        await this.notify(state.goalThreadId,
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
              task.threadId = undefined;
              task.dispatchedAt = undefined;
            }
            stateModified = true;
          } catch {
            task.status = 'failed';
            task.error = 'Cannot verify worktree after restart';
            stateModified = true;
          }
        }
      }
      if (stateModified) await this.saveState(state);

      this.activeDrives.set(state.goalId, state);
      logger.info(`[Orchestrator] Restored drive: ${state.goalName} (${state.goalId})`);
      await this.dispatchNext(state);
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

  private async dispatchNext(state: GoalDriveState): Promise<void> {
    if (state.status !== 'running') return;

    if (isGoalComplete(state)) {
      state.status = 'completed';
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `**Goal "${state.goalName}" completed!**\n` +
        `Review branch \`${state.goalBranch}\` and merge to main.`,
        'success'
      );
      return;
    }

    if (isGoalStuck(state)) {
      await this.notify(state.goalThreadId,
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
        await this.notify(state.goalThreadId,
          `Manual task pending: ${task.id} - ${task.description}\nReply "done ${task.id}" when complete.`,
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
    const branchName = await this.generateBranchName(task);
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

      // 从 goal channel 向上查找 Category（支持 Thread → Channel → Category）
      let categoryId: string | null = null;
      try {
        let channel = await this.deps.client.channels.fetch(state.goalThreadId);
        for (let i = 0; i < 3 && channel; i++) {
          if (channel.type === ChannelType.GuildCategory) {
            categoryId = channel.id;
            break;
          }
          if ('parentId' in channel && channel.parentId) {
            channel = await this.deps.client.channels.fetch(channel.parentId);
          } else {
            break;
          }
        }
      } catch { /* ignore */ }

      if (!categoryId) {
        throw new Error('Cannot find Category for goal channel');
      }

      const guild = await this.deps.client.guilds.fetch(guildId);
      const title = await generateTopicTitle(task.description);
      const channelName = `${task.id} ${title}`.slice(0, 100);

      const textChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: `Goal subtask: ${task.id}`,
      });

      // 发送初始消息
      const initEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[goal] Task: \`${task.id}\` - ${task.description}\nBranch: \`${branchName}\`\nWorking directory: \`${subtaskDir}\``.slice(0, 4096));
      await textChannel.send({ embeds: [initEmbed] });

      const newThreadId = textChannel.id;

      this.deps.stateManager.getOrCreateSession(guildId, newThreadId, {
        name: channelName,
        cwd: subtaskDir,
      });
      this.deps.stateManager.setSessionForkInfo(guildId, newThreadId, state.goalThreadId, branchName);

      task.threadId = newThreadId;
      task.status = 'running';
      await this.saveState(state);

      await this.notify(state.goalThreadId,
        `Dispatched: ${task.id} - ${task.description} → \`${branchName}\``,
        'info'
      );

      const taskPrompt = this.buildTaskPrompt(task, state);
      this.executeTaskInBackground(state.goalId, task.id, guildId, newThreadId, taskPrompt);

    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `Dispatch failed: ${task.id} - ${task.description}\nError: ${err.message}`,
        'error'
      );
    }
  }

  private executeTaskInBackground(
    goalId: string,
    taskId: string,
    guildId: string,
    threadId: string,
    message: string
  ): void {
    (async () => {
      try {
        logger.info(`[Orchestrator] Task ${taskId} executing in channel ${threadId}`);
        await this.deps.messageHandler.handleBackgroundChat(guildId, threadId, message);
        logger.info(`[Orchestrator] Task ${taskId} completed`);
        await this.onTaskCompleted(goalId, taskId);
      } catch (err: any) {
        logger.error(`[Orchestrator] Task ${taskId} failed:`, err.message);
        try {
          await this.onTaskFailed(goalId, taskId, err.message);
        } catch (cbErr: any) {
          logger.error(`[Orchestrator] onTaskFailed callback also failed:`, cbErr.message);
        }
      }
    })();
  }

  private async onTaskCompleted(goalId: string, taskId: string): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'completed';
      task.completedAt = Date.now();
      await this.saveState(state);
      await this.notify(state.goalThreadId, `Completed: ${task.id} - ${task.description}`, 'success');
      if (task.branchName) await this.mergeAndCleanup(state, task);
      const refreshed = await this.getState(goalId);
      if (refreshed && refreshed.status === 'running') await this.dispatchNext(refreshed);
    });
  }

  private async onTaskFailed(goalId: string, taskId: string, error: string): Promise<void> {
    await this.withStateLock(goalId, async () => {
      const state = await this.getState(goalId);
      if (!state) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'failed';
      task.error = error;
      await this.saveState(state);
      await this.notify(state.goalThreadId,
        `Failed: ${task.id} - ${task.description}\nError: ${error}\n\nReply "retry ${task.id}" to retry.`,
        'error'
      );
      if (state.status === 'running') await this.dispatchNext(state);
    });
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
        await this.notify(state.goalThreadId, `Cannot find goal worktree, skipping merge: ${branchName}`, 'warning');
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
        await this.notify(state.goalThreadId, `Merged: \`${branchName}\` → \`${state.goalBranch}\``, 'success');

        if (subtaskDir) {
          await cleanupSubtask(state.baseCwd, subtaskDir, branchName);
        }

        // Delete subtask channel
        if (task.threadId) {
          const guildId = this.getGuildId();
          if (guildId) {
            this.deps.stateManager.archiveSession(guildId, task.threadId, undefined, 'merged');
            try {
              const channel = await this.deps.client.channels.fetch(task.threadId);
              if (channel && 'delete' in channel) {
                await (channel as any).delete('Task merged and cleaned up').catch(() => {});
              }
            } catch { /* ignore */ }
          }
        }
      } else if (result.conflict) {
        await this.notify(state.goalThreadId,
          `Merge conflict: \`${branchName}\` → \`${state.goalBranch}\`\n` +
          `Manual resolution needed.\n` +
          `Reply "done ${task.id}" when resolved.`,
          'error'
        );
        task.status = 'blocked';
        task.error = 'merge conflict';
        await this.saveState(state);
      } else {
        await this.notify(state.goalThreadId, `Merge failed: ${branchName}\nError: ${result.error}`, 'error');
      }
    } catch (err: any) {
      logger.error(`[Orchestrator] mergeAndCleanup error: ${err.message}`);
    }
  }

  private async generateBranchName(task: GoalTask): Promise<string> {
    const prefix = task.type === '调研' ? 'research' : 'feat';
    const translated = await translateToBranchName(task.description);
    return `${prefix}/${task.id}-${translated.slice(0, 30) || 'task'}`;
  }

  private buildTaskPrompt(task: GoalTask, state: GoalDriveState): string {
    return [
      `You are a subtask executor for Goal "${state.goalName}".`,
      ``,
      `## Current Task`,
      `ID: ${task.id}`,
      `Type: ${task.type}`,
      `Description: ${task.description}`,
      ``,
      `## Requirements`,
      `1. Focus on completing the task above`,
      `2. Ensure all code is saved when done`,
      `3. If you need user decisions, ask clearly`,
      `4. Do not modify code unrelated to this task`,
    ].join('\n');
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

  private async notify(threadId: string, message: string, type?: 'success' | 'error' | 'warning' | 'info'): Promise<void> {
    try {
      const colorMap: Record<string, EmbedColor> = {
        success: EmbedColors.GREEN,
        error: EmbedColors.RED,
        warning: EmbedColors.YELLOW,
        info: EmbedColors.GRAY,
      };
      const embedColor = type ? colorMap[type] : undefined;
      await this.deps.mq.sendLong(threadId, message, { embedColor });
    } catch (err: any) {
      logger.error(`[Orchestrator] Failed to send notification: ${err.message}`);
    }
  }

  private getGuildId(): string | null {
    return getAuthorizedGuildId() ?? null;
  }
}
