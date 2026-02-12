/**
 * Fork Topic 核心逻辑（供 REST API 和 Bot 命令共用）
 */

import { resolve } from 'path';
import { mkdir } from 'fs/promises';
import { isGitRepo, getRepoName, createWorktree } from './git-utils.js';
import type { StateManager } from '../bot/state.js';
import type { Telegram } from 'telegraf';

export interface ForkTopicDeps {
  stateManager: StateManager;
  telegram: Telegram;
  worktreesDir: string;
}

export interface ForkTopicResult {
  topicId: number;
  topicName: string;
  branchName: string;
  cwd: string;
}

/**
 * 从指定 topic 创建 fork：创建 worktree → 创建 Telegram topic → 创建 session → 设置 fork 关系
 */
export async function forkTopicCore(
  groupId: number,
  parentTopicId: number,
  branchName: string,
  deps: ForkTopicDeps,
  topicTitle?: string,
): Promise<ForkTopicResult> {
  const { stateManager, telegram, worktreesDir } = deps;

  const session = stateManager.getSession(groupId, parentTopicId);
  if (!session) {
    throw new Error('Parent topic not found');
  }

  const gitRepo = await isGitRepo(session.cwd);
  if (!gitRepo) {
    throw new Error(`${session.cwd} is not a git repository`);
  }

  const repoName = await getRepoName(session.cwd);
  const dirSafeBranch = branchName.replaceAll('/', '_');
  const worktreeDir = resolve(worktreesDir, `${repoName}_${dirSafeBranch}`);
  await mkdir(worktreesDir, { recursive: true });
  await createWorktree(session.cwd, worktreeDir, branchName);

  const newTopicName = topicTitle || `${session.name}/${branchName}`;
  const rootSession = stateManager.getRootSession(groupId, parentTopicId);
  const iconOpts: Record<string, any> = {};
  if (rootSession?.iconCustomEmojiId) {
    iconOpts.icon_custom_emoji_id = rootSession.iconCustomEmojiId;
  } else if (rootSession?.iconColor != null) {
    iconOpts.icon_color = rootSession.iconColor;
  } else {
    iconOpts.icon_color = 0x6FB9F0;
  }
  const forumTopic = await telegram.createForumTopic(groupId, newTopicName, iconOpts);

  const newTopicId = forumTopic.message_thread_id;
  stateManager.getOrCreateSession(groupId, newTopicId, {
    name: newTopicName,
    cwd: worktreeDir,
  });
  stateManager.setSessionIcon(groupId, newTopicId, forumTopic.icon_color, forumTopic.icon_custom_emoji_id);
  stateManager.setSessionForkInfo(groupId, newTopicId, parentTopicId, branchName);

  return {
    topicId: newTopicId,
    topicName: newTopicName,
    branchName,
    cwd: worktreeDir,
  };
}
