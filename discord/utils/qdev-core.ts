/**
 * qdev 核心逻辑（供 REST API 和 Discord 命令共用）
 *
 * 职责：
 *  1. 生成/接受分支名和频道名
 *  2. 以当前 channel 为父节点（从当前分支 fork，而非 root/main）
 *  3. 调用 forkTaskCore 创建 worktree（可选）+ Discord channel + session
 *  4. 持久化到 TaskRepo
 *  5. 设置 model
 *
 * 注意：后台触发 Claude（handleBackgroundChat）由调用方自行处理。
 */

import { generateBranchName } from './git-utils.js';
import { generateTopicTitle } from './llm.js';
import { forkTaskCore, type ForkTaskDeps, type ForkTaskResult } from './fork-task.js';
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
  /** 从哪个分支 fork worktree；不传则基于当前 channel 的分支 */
  baseBranch?: string;
  /**
   * 是否创建新的 worktree（默认 true）。
   * - true（默认）：从当前 channel 的分支 fork 出新 branch + worktree + Discord channel
   * - false：仅创建新 Discord channel + session，复用当前 channel 的 worktree
   */
  worktree?: boolean;
}

export interface QdevResult extends ForkTaskResult {
  parentChannelId: string;
}

export async function qdevCore(options: QdevOptions, deps: ForkTaskDeps): Promise<QdevResult> {
  const { guildId, channelId, description, model, categoryId, baseBranch } = options;
  const shouldCreateWorktree = options.worktree !== false;  // 默认 true

  // 0. 入参校验
  if (options.baseBranch?.startsWith('-')) {
    throw new Error(`Invalid base_branch: "${options.baseBranch}" (must not start with '-')`);
  }
  if (options.branchName?.startsWith('-')) {
    throw new Error(`Invalid branch_name: "${options.branchName}" (must not start with '-')`);
  }

  // 1. 生成频道名；仅在创建新 worktree 时才需要生成分支名
  let resolvedBranchName: string;
  let resolvedChannelName: string;

  if (shouldCreateWorktree) {
    // 并行生成分支名和频道名
    [resolvedBranchName, resolvedChannelName] = await Promise.all([
      options.branchName ? Promise.resolve(options.branchName) : generateBranchName(description),
      options.channelName ? Promise.resolve(options.channelName) : generateTopicTitle(description),
    ]);
  } else {
    // 不创建 worktree：只需要频道名，分支名复用当前 channel 的分支
    resolvedChannelName = options.channelName
      ? options.channelName
      : await generateTopicTitle(description);
    const currentSession = deps.stateManager.getSession(guildId, channelId);
    resolvedBranchName = currentSession?.worktreeBranch ?? '';
  }

  // 2. 使用当前 channel 作为父节点（从当前 channel 的分支 fork，而非 root/main）
  const parentChannelId = channelId;

  // 3. Fork: 创建 Discord Text Channel + session（可选创建 worktree）
  const forkResult = await forkTaskCore(
    guildId,
    parentChannelId,
    resolvedBranchName,
    categoryId,
    deps,
    resolvedChannelName,
    baseBranch,
    shouldCreateWorktree,
  );

  // 4. 持久化到 TaskRepo（goalId=null 表示独立任务）
  // 非致命：channel 已建，DB 记录缺失不阻断 Claude 运行
  try {
    const repo = getTaskRepo();
    await repo.save({
      id: forkResult.channelId,
      description,
      type: '代码',
      status: 'dispatched',
      branchName: forkResult.branchName || undefined,
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

  return {
    ...forkResult,
    parentChannelId,
  };
}
