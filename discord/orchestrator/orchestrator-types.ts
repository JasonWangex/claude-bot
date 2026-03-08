/**
 * GoalOrchestrator 共享类型定义
 *
 * 所有 handler 文件和 index.ts 共同依赖此文件，
 * 确保依赖图为 DAG（无循环依赖）。
 */

import type { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import type { MessageQueue } from '../bot/message-queue.js';
import type { Client } from 'discord.js';
import type { DiscordBotConfig } from '../types/index.js';
import type { IGoalRepo, ITaskRepo, IGoalTodoRepo, IChannelRepo } from '../types/repository.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';
import type { TaskEventRepo } from '../db/repo/task-event-repo.js';
import type { GoalTimelineRepo } from '../db/repo/goal-timeline-repo.js';
import type { GoalEventRepo } from '../db/repo/goal-event-repo.js';

export interface OrchestratorDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  messageHandler: MessageHandler;
  client: Client;
  mq: MessageQueue;
  config: DiscordBotConfig;
  goalRepo: IGoalRepo;
  taskRepo: ITaskRepo;
  goalTodoRepo: IGoalTodoRepo;
  channelRepo: IChannelRepo;
  promptService: PromptConfigService;
  taskEventRepo: TaskEventRepo;
  goalTimelineRepo: GoalTimelineRepo;
  goalEventRepo: GoalEventRepo;
}

export interface MergeConflictPayload {
  branchName: string;
  goalWorktreeDir: string;
  subtaskDir: string | null;
  taskDescription: string;
}

/** startDrive 的入参（tasks 已提前由 Claude 写入 DB，此处不再传递） */
export interface StartDriveParams {
  goalId: string;
  goalName: string;
  goalChannelId: string;
  baseCwd: string;
  maxConcurrent?: number;
}

/** 通知选项 */
export interface NotifyOptions {
  components?: import('discord.js').ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>[];
  logOnly?: boolean;
  driveChannel?: boolean;
}

export enum NotifyType {
  Success  = 'success',
  Error    = 'error',
  Warning  = 'warning',
  Info     = 'info',
  Pipeline = 'pipeline',
}

// Constants
export const CHECK_IN_COOLDOWN = 10 * 60 * 1000;  // 10 分钟
export const MAX_CHECK_INS = 3;
export const MAX_REVIEW_RETRIES = 3;
