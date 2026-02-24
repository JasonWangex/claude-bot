/**
 * qdev 核心逻辑（供 REST API 和 Discord 命令共用）
 *
 * 职责：
 *  1. 生成/接受分支名和频道名
 *  2. 找到 root session
 *  3. 调用 forkTaskCore 创建 worktree + Discord channel + session
 *  4. 持久化到 TaskRepo
 *  5. 设置 model
 *  6. 发送描述 embed 到新频道
 *
 * 注意：后台触发 Claude（handleBackgroundChat）由调用方自行处理。
 */

import { EmbedBuilder } from 'discord.js';
import { generateBranchName } from './git-utils.js';
import { generateTopicTitle } from './llm.js';
import { forkTaskCore, type ForkTaskDeps, type ForkTaskResult } from './fork-task.js';
import { EmbedColors } from '../bot/message-queue.js';
import { TaskRepo } from '../db/repo/task-repo.js';
import { getDb } from '../db/index.js';
import { logger } from './logger.js';

let taskRepo: TaskRepo | null = null;
function getTaskRepo(): TaskRepo {
  if (!taskRepo) taskRepo = new TaskRepo(getDb());
  return taskRepo;
}

export interface QdevOptions {
  guildId: string;
  channelId: string;
  description: string;
  /** 使用哪个 Claude 模型（可选，不传则用频道默认） */
  model?: string;
  /** 新频道所在的 Discord Category ID */
  categoryId: string;
  /** 自定义分支名；不传则由 LLM 根据描述生成 */
  branchName?: string;
  /** 自定义 Discord 频道名；不传则由 LLM 根据描述生成 */
  channelName?: string;
  /** 从哪个分支 fork worktree；不传则基于当前 HEAD */
  baseBranch?: string;
}

export interface QdevResult extends ForkTaskResult {
  parentChannelId: string;
}

export async function qdevCore(options: QdevOptions, deps: ForkTaskDeps): Promise<QdevResult> {
  const { guildId, channelId, description, model, categoryId, baseBranch } = options;

  // 0. 入参校验（先于解构，统一用 options.*）
  if (options.baseBranch?.startsWith('-')) {
    throw new Error(`Invalid base_branch: "${options.baseBranch}" (must not start with '-')`);
  }
  if (options.branchName?.startsWith('-')) {
    throw new Error(`Invalid branch_name: "${options.branchName}" (must not start with '-')`);
  }

  // 1. 并行生成分支名和频道名（如果调用方未提供）
  const [resolvedBranchName, resolvedChannelName] = await Promise.all([
    options.branchName ? Promise.resolve(options.branchName) : generateBranchName(description),
    options.channelName ? Promise.resolve(options.channelName) : generateTopicTitle(description),
  ]);

  // 2. 找到 root session（新频道挂在 root 下，而非当前子频道）
  const rootSession = deps.stateManager.getRootSession(guildId, channelId);
  const parentChannelId = rootSession?.channelId ?? channelId;

  // 3. Fork: 创建 worktree + Discord Text Channel + session
  const forkResult = await forkTaskCore(
    guildId,
    parentChannelId,
    resolvedBranchName,
    categoryId,
    deps,
    resolvedChannelName,
    baseBranch,
  );

  // 4. 持久化到 TaskRepo（goalId=null 表示独立任务）
  // 非致命：worktree/channel 已建，DB 记录缺失不阻断 Claude 运行
  try {
    const repo = getTaskRepo();
    await repo.save({
      id: forkResult.channelId,
      description,
      type: '代码',
      status: 'dispatched',
      branchName: forkResult.branchName,
      channelId: forkResult.channelId,
      dispatchedAt: Date.now(),
    }, null);
  } catch (err) {
    logger.warn('[qdevCore] TaskRepo.save failed, task will be untracked in DB:', err);
  }

  // 5. 设置自定义 model（如果指定）
  if (model) {
    deps.stateManager.setSessionModel(guildId, forkResult.channelId, model);
  }

  // 6. 发送描述 embed 到新频道（非致命：send 失败不影响任务已建立的状态）
  try {
    const newChannel = await deps.client.channels.fetch(forkResult.channelId);
    if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
      const descEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[qdev] ${description}`.slice(0, 4096));
      await (newChannel as any).send({ embeds: [descEmbed] });
    }
  } catch (err) {
    logger.warn('[qdevCore] Failed to send description embed:', err);
  }

  return {
    ...forkResult,
    parentChannelId,
  };
}
