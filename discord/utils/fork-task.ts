/**
 * Fork Task 核心逻辑（供 REST API 和 Bot 命令共用）
 * Discord 版：使用 forum.threads.create() 代替 Telegram createForumTopic()
 */

import { resolve } from 'path';
import { mkdir } from 'fs/promises';
import { ChannelType, ForumChannel, type Client } from 'discord.js';
import { isGitRepo, getRepoName, createWorktree, removeWorktree } from './git-utils.js';
import { logger } from './logger.js';
import type { StateManager } from '../bot/state.js';

export interface ForkTaskDeps {
  stateManager: StateManager;
  client: Client;
  worktreesDir: string;
}

export interface ForkTaskResult {
  threadId: string;
  threadName: string;
  branchName: string;
  cwd: string;
}

/**
 * 从指定 thread 创建 fork：创建 worktree → 创建 Forum Post → 创建 session → 设置 fork 关系
 */
export async function forkTaskCore(
  guildId: string,
  parentThreadId: string,
  branchName: string,
  forumChannelId: string,
  deps: ForkTaskDeps,
  threadTitle?: string,
): Promise<ForkTaskResult> {
  const { stateManager, client, worktreesDir } = deps;

  const session = stateManager.getSession(guildId, parentThreadId);
  if (!session) {
    throw new Error('Parent thread not found');
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

  const newThreadName = threadTitle || `${session.name}/${branchName}`;

  // 创建 Discord Forum Post
  const forumChannel = await client.channels.fetch(forumChannelId);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    throw new Error(`Forum channel ${forumChannelId} not found or not a forum`);
  }

  const forum = forumChannel as ForumChannel;

  // 查找 "developing" tag
  const developingTag = forum.availableTags.find(t => t.name === 'developing');

  let thread;
  try {
    thread = await forum.threads.create({
      name: newThreadName.slice(0, 100), // Discord 限制 100 字符
      message: {
        content: `Task created: \`${branchName}\`\nWorking directory: \`${worktreeDir}\``,
      },
      appliedTags: developingTag ? [developingTag.id] : [],
    });
  } catch (err) {
    // 回滚 worktree
    logger.warn(`Thread creation failed, rolling back worktree: ${worktreeDir}`);
    await removeWorktree(session.cwd, worktreeDir).catch(e =>
      logger.error(`Worktree rollback failed: ${e.message}`)
    );
    throw err;
  }

  const newThreadId = thread.id;
  stateManager.getOrCreateSession(guildId, newThreadId, {
    name: newThreadName,
    cwd: worktreeDir,
  });
  stateManager.setSessionForkInfo(guildId, newThreadId, parentThreadId, branchName);

  return {
    threadId: newThreadId,
    threadName: newThreadName,
    branchName,
    cwd: worktreeDir,
  };
}
