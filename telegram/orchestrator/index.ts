/**
 * GoalOrchestrator — Goal 自动调度引擎
 *
 * 负责：
 * 1. 启动 Goal drive（创建 goal 分支 + topic）
 * 2. 自动派发子任务到独立 worktree/topic
 * 3. 监控子任务完成 → 自动 merge 到 goal 分支
 * 4. 全程通知用户，异常时暂停等待干预
 */

import type { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import type { MessageQueue } from '../bot/message-queue.js';
import type { TelegramBotConfig, GoalDriveState, GoalTask } from '../types/index.js';
import type { Telegram } from 'telegraf';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAuthorizedChatId } from '../utils/env.js';

const execFileAsync = promisify(execFile);
import { loadState, saveState, loadAllRunningStates, parseTasks, goalNameToBranch } from './goal-state.js';
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
  telegram: Telegram;
  mq: MessageQueue;
  config: TelegramBotConfig;
}

/** startDrive 的入参 */
export interface StartDriveParams {
  goalId: string;
  goalName: string;
  goalTopicId: number;
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
  private mergeLock = false;
  // 记录正在运行的 goal drives（goalId → state）
  private activeDrives = new Map<string, GoalDriveState>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** 启动 Goal 自动推进 */
  async startDrive(params: StartDriveParams): Promise<GoalDriveState> {
    const { goalId, goalName, goalTopicId, baseCwd, tasks: rawTasks, maxConcurrent = 3 } = params;

    // 检查是否已经在运行
    const existing = this.activeDrives.get(goalId) || loadState(goalId);
    if (existing && existing.status === 'running') {
      await this.notify(goalTopicId, `⚠️ Goal "${goalName}" 已在运行中`);
      return existing;
    }

    const goalBranch = goalNameToBranch(goalName);

    // 创建 goal 分支和 worktree
    let goalWorktreeDir: string;
    try {
      goalWorktreeDir = await createGoalBranch(baseCwd, goalBranch, this.deps.config.worktreesDir);
    } catch (err: any) {
      await this.notify(goalTopicId, `❌ 创建 goal 分支失败: ${err.message}`);
      throw err;
    }

    // 初始化状态
    const state: GoalDriveState = {
      goalId,
      goalName,
      goalBranch,
      goalTopicId,
      baseCwd,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxConcurrent,
      tasks: parseTasks(rawTasks),
    };

    saveState(state);
    this.activeDrives.set(goalId, state);

    await this.notify(goalTopicId,
      `🎯 Goal Drive 已启动: ${goalName}\n` +
      `📌 分支: ${goalBranch}\n` +
      `📊 子任务: ${state.tasks.length} 个\n` +
      `⚡ 最大并发: ${maxConcurrent}`
    );

    // 开始派发
    await this.dispatchNext(state);

    return state;
  }

  /** 暂停 Goal drive */
  async pauseDrive(goalId: string): Promise<boolean> {
    const state = this.getState(goalId);
    if (!state || state.status !== 'running') return false;

    state.status = 'paused';
    saveState(state);
    await this.notify(state.goalTopicId, `⏸ Goal "${state.goalName}" 已暂停`);
    return true;
  }

  /** 恢复 Goal drive */
  async resumeDrive(goalId: string): Promise<boolean> {
    const state = this.getState(goalId);
    if (!state || state.status !== 'paused') return false;

    state.status = 'running';
    saveState(state);
    await this.notify(state.goalTopicId, `▶️ Goal "${state.goalName}" 已恢复`);
    await this.dispatchNext(state);
    return true;
  }

  /** 获取 Goal drive 状态 */
  getStatus(goalId: string): GoalDriveState | null {
    return this.getState(goalId);
  }

  /** 跳过某个子任务 */
  async skipTask(goalId: string, taskId: string): Promise<boolean> {
    const state = this.getState(goalId);
    if (!state) return false;

    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return false;
    if (task.status !== 'pending' && task.status !== 'blocked' && task.status !== 'failed') return false;

    task.status = 'skipped';
    saveState(state);
    await this.notify(state.goalTopicId, `⏭ 已跳过子任务: ${task.id} - ${task.description}`);

    if (state.status === 'running') {
      await this.dispatchNext(state);
    }
    return true;
  }

  /** 标记手动任务完成 */
  async markTaskDone(goalId: string, taskId: string): Promise<boolean> {
    const state = this.getState(goalId);
    if (!state) return false;

    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'blocked') return false;

    task.status = 'completed';
    task.completedAt = Date.now();
    saveState(state);
    await this.notify(state.goalTopicId, `✅ 手动任务已完成: ${task.id} - ${task.description}`);

    if (state.status === 'running') {
      await this.dispatchNext(state);
    }
    return true;
  }

  /** 重试失败的子任务 */
  async retryTask(goalId: string, taskId: string): Promise<boolean> {
    const state = this.getState(goalId);
    if (!state) return false;

    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status !== 'failed') return false;

    task.status = 'pending';
    task.error = undefined;
    task.branchName = undefined;
    task.topicId = undefined;
    task.dispatchedAt = undefined;
    task.merged = false;
    saveState(state);
    await this.notify(state.goalTopicId, `🔄 重试子任务: ${task.id} - ${task.description}`);

    if (state.status === 'running') {
      await this.dispatchNext(state);
    }
    return true;
  }

  /** Bot 重启后恢复运行中的 drives */
  async restoreRunningDrives(): Promise<void> {
    const states = loadAllRunningStates();
    for (const state of states) {
      this.activeDrives.set(state.goalId, state);
      logger.info(`[Orchestrator] Restored drive: ${state.goalName} (${state.goalId})`);
      // 检查是否有可派发的任务
      // 注意：已经 dispatched 的任务的 Claude 进程由 executor reconnect 恢复
      await this.dispatchNext(state);
    }
    if (states.length > 0) {
      logger.info(`[Orchestrator] Restored ${states.length} running drives`);
    }
  }

  // ========== 内部方法 ==========

  private getState(goalId: string): GoalDriveState | null {
    return this.activeDrives.get(goalId) || loadState(goalId);
  }

  /** 派发下一批可执行的子任务 */
  private async dispatchNext(state: GoalDriveState): Promise<void> {
    if (state.status !== 'running') return;

    // 检查是否全部完成
    if (isGoalComplete(state)) {
      state.status = 'completed';
      saveState(state);
      await this.notify(state.goalTopicId,
        `🎉 Goal "${state.goalName}" 全部子任务完成！\n` +
        `请审核 ${state.goalBranch} 分支后合并到 main`
      );
      return;
    }

    // 检查是否卡住
    if (isGoalStuck(state)) {
      await this.notify(state.goalTopicId,
        `⚠️ Goal "${state.goalName}" 调度卡住\n` +
        `可能有未解决的依赖或失败任务\n` +
        `进度: ${getProgressSummary(state)}`
      );
      return;
    }

    const batch = getNextBatch(state);

    // 通知手动任务被标记为 blocked
    const blockedTasks = state.tasks.filter(t => t.status === 'blocked');
    for (const task of blockedTasks) {
      if (!task.notifiedBlocked) {
        task.notifiedBlocked = true;
        await this.notify(state.goalTopicId,
          `👋 手动任务待处理: ${task.id} - ${task.description}\n完成后回复 "done ${task.id}"`
        );
      }
    }

    saveState(state);

    // 派发可执行任务
    for (const task of batch) {
      await this.dispatchTask(state, task);
    }
  }

  /** 派发单个子任务 */
  private async dispatchTask(state: GoalDriveState, task: GoalTask): Promise<void> {
    const branchName = this.generateBranchName(task);
    task.branchName = branchName;
    task.status = 'dispatched';
    task.dispatchedAt = Date.now();
    saveState(state);

    try {
      // 获取 goal worktree 目录
      const { stdout } = await execFileAsync(
        'git', ['worktree', 'list', '--porcelain'],
        { cwd: state.baseCwd }
      );

      // 解析 worktree list 找到 goal 分支对应的目录
      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        throw new Error(`Goal worktree for ${state.goalBranch} not found`);
      }

      // 创建子任务 worktree
      const subtaskDir = await createSubtaskBranch(
        goalWorktreeDir,
        branchName,
        this.deps.config.worktreesDir
      );

      // 在 Telegram 中 fork topic
      const groupId = this.getGroupId();
      if (!groupId) throw new Error('Bot not authorized');

      // 获取 root session（goal topic 的 parent）
      const goalSession = this.deps.stateManager.getSession(groupId, state.goalTopicId);
      const iconOpts: Record<string, any> = {};
      if (goalSession?.iconCustomEmojiId) {
        iconOpts.icon_custom_emoji_id = goalSession.iconCustomEmojiId;
      } else if (goalSession?.iconColor != null) {
        iconOpts.icon_color = goalSession.iconColor;
      } else {
        iconOpts.icon_color = 0x6FB9F0;
      }

      const topicName = `${state.goalName}/${task.id}`;
      const forumTopic = await this.deps.telegram.createForumTopic(groupId, topicName, iconOpts);
      const newTopicId = forumTopic.message_thread_id;

      // 创建 session
      this.deps.stateManager.getOrCreateSession(groupId, newTopicId, {
        name: topicName,
        cwd: subtaskDir,
      });
      this.deps.stateManager.setSessionIcon(groupId, newTopicId, forumTopic.icon_color, forumTopic.icon_custom_emoji_id);
      this.deps.stateManager.setSessionForkInfo(groupId, newTopicId, state.goalTopicId, branchName);

      task.topicId = newTopicId;
      task.status = 'running';
      saveState(state);

      await this.notify(state.goalTopicId,
        `🚀 派发: ${task.id} - ${task.description} → ${branchName}`
      );

      // 发送任务消息到子 topic，触发 Claude 执行
      const taskPrompt = this.buildTaskPrompt(task, state);

      // 后台执行（fire-and-forget），通过 onComplete 回调处理完成
      this.executeTaskInBackground(state.goalId, task.id, groupId, newTopicId, taskPrompt);

    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      saveState(state);
      await this.notify(state.goalTopicId,
        `❌ 派发失败: ${task.id} - ${task.description}\n错误: ${err.message}`
      );
    }
  }

  /** 后台执行子任务并处理完成 */
  private executeTaskInBackground(
    goalId: string,
    taskId: string,
    groupId: number,
    topicId: number,
    message: string
  ): void {
    (async () => {
      try {
        logger.info(`[Orchestrator] Task ${taskId} executing in topic ${topicId}`);
        await this.deps.messageHandler.handleBackgroundChat(groupId, topicId, message);
        logger.info(`[Orchestrator] Task ${taskId} completed`);

        // 子任务完成回调
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

  /** 子任务完成时的回调 */
  private async onTaskCompleted(goalId: string, taskId: string): Promise<void> {
    const state = this.getState(goalId);
    if (!state) return;

    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    task.status = 'completed';
    task.completedAt = Date.now();
    saveState(state);

    await this.notify(state.goalTopicId,
      `✅ 完成: ${task.id} - ${task.description}`
    );

    // 自动 merge 到 goal 分支
    if (task.branchName) {
      await this.mergeAndCleanup(state, task);
    }

    // 刷新状态（merge 可能修改了 state）
    const refreshed = this.getState(goalId);
    if (refreshed && refreshed.status === 'running') {
      await this.dispatchNext(refreshed);
    }
  }

  /** 子任务失败时的回调 */
  private async onTaskFailed(goalId: string, taskId: string, error: string): Promise<void> {
    const state = this.getState(goalId);
    if (!state) return;

    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    task.status = 'failed';
    task.error = error;
    saveState(state);

    await this.notify(state.goalTopicId,
      `❌ 失败: ${task.id} - ${task.description}\n错误: ${error}\n\n回复 "retry ${task.id}" 重试`
    );

    // 继续派发其他不依赖该任务的任务
    if (state.status === 'running') {
      await this.dispatchNext(state);
    }
  }

  /** 合并子任务分支到 goal 分支并清理 */
  private async mergeAndCleanup(state: GoalDriveState, task: GoalTask): Promise<void> {
    if (!task.branchName) return;

    // 串行化 merge（防止并发冲突）
    while (this.mergeLock) {
      await new Promise(r => setTimeout(r, 500));
    }
    this.mergeLock = true;

    try {
      // 找到 goal worktree 目录
      const { stdout } = await execFileAsync(
        'git', ['worktree', 'list', '--porcelain'],
        { cwd: state.baseCwd }
      );
      const goalWorktreeDir = this.findWorktreeDir(stdout, state.goalBranch);
      if (!goalWorktreeDir) {
        await this.notify(state.goalTopicId,
          `⚠️ 无法找到 goal worktree，跳过合并: ${task.branchName}`
        );
        return;
      }

      // 检查子任务 worktree 是否有未提交更改
      const subtaskDir = this.getSubtaskDir(task.branchName);
      if (subtaskDir) {
        const hasChanges = await hasUncommittedChanges(subtaskDir);
        if (hasChanges) {
          await autoCommit(subtaskDir, `auto: ${task.description}`);
        }
      }

      // merge
      const result = await mergeSubtaskBranch(goalWorktreeDir, task.branchName);

      if (result.success) {
        task.merged = true;
        saveState(state);

        await this.notify(state.goalTopicId,
          `🔀 已合并: ${task.branchName} → ${state.goalBranch}`
        );

        // 清理子任务 worktree 和分支
        if (subtaskDir) {
          await cleanupSubtask(state.baseCwd, subtaskDir, task.branchName);
        }

        // 清理子任务 topic
        if (task.topicId) {
          const groupId = this.getGroupId();
          if (groupId) {
            this.deps.stateManager.deleteSession(groupId, task.topicId);
            await this.deps.telegram.deleteForumTopic(groupId, task.topicId).catch(() => {});
          }
        }
      } else if (result.conflict) {
        await this.notify(state.goalTopicId,
          `⚠️ 合并冲突: ${task.branchName} → ${state.goalBranch}\n` +
          `需要手动处理。\n` +
          `处理完成后回复 "done ${task.id}"`
        );
        task.status = 'blocked';
        task.error = 'merge conflict';
        saveState(state);
      } else {
        await this.notify(state.goalTopicId,
          `❌ 合并失败: ${task.branchName}\n错误: ${result.error}`
        );
      }
    } finally {
      this.mergeLock = false;
    }
  }

  // ========== 辅助方法 ==========

  /** 生成子任务分支名 */
  private generateBranchName(task: GoalTask): string {
    const prefix = task.type === '调研' ? 'research' : 'feat';
    const sanitized = task.description
      .replace(/[^a-z0-9\u4e00-\u9fff]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)
      .toLowerCase();
    return `${prefix}/${task.id}-${sanitized || 'task'}`;
  }

  /** 构建子任务的 Claude 提示词 */
  private buildTaskPrompt(task: GoalTask, state: GoalDriveState): string {
    return [
      `你是 Goal "${state.goalName}" 的子任务执行者。`,
      ``,
      `## 当前子任务`,
      `ID: ${task.id}`,
      `类型: ${task.type}`,
      `描述: ${task.description}`,
      ``,
      `## 要求`,
      `1. 专注完成上述子任务`,
      `2. 完成后确保所有代码已保存`,
      `3. 如果遇到需要用户决策的问题，请明确提出`,
      `4. 不要修改与任务无关的代码`,
    ].join('\n');
  }

  /** 从 worktree list 输出中找到特定分支的目录 */
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

  /** 获取子任务 worktree 目录路径 */
  private getSubtaskDir(branchName: string): string | null {
    return resolve(
      this.deps.config.worktreesDir,
      `${branchName.replace(/\//g, '_')}`
    );
  }

  /** 发送通知到 Goal Topic */
  private async notify(topicId: number, message: string): Promise<void> {
    const groupId = this.getGroupId();
    if (!groupId) return;
    try {
      await this.deps.mq.send(groupId, topicId, message, { silent: false, priority: 'high' });
    } catch (err: any) {
      logger.error(`[Orchestrator] Failed to send notification: ${err.message}`);
    }
  }

  /** 获取已授权的 chat ID */
  private getGroupId(): number | null {
    return getAuthorizedChatId() ?? null;
  }
}
