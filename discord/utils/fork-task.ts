/**
 * Fork Task 核心逻辑（供 REST API 和 Bot 命令共用）
 * Discord 版：使用 guild.channels.create() 在 Category 下创建 Text Channel
 */

import { resolve } from 'path';
import { mkdir } from 'fs/promises';
import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import { isGitRepo, getRepoName, createWorktree, removeWorktree } from './git-utils.js';
import { logger } from './logger.js';
import { EmbedColors } from '../bot/message-queue.js';
import type { StateManager } from '../bot/state.js';
import type { ChannelService } from '../services/channel-service.js';

export interface ForkTaskDeps {
  stateManager: StateManager;
  client: Client;
  worktreesDir: string;
  channelService?: ChannelService;
}

export interface ForkTaskResult {
  channelId: string;
  channelName: string;
  branchName: string;
  cwd: string;
}

/**
 * 从指定 channel 创建 fork：创建 worktree → 创建 Text Channel → 创建 session → 设置 fork 关系
 */
export async function forkTaskCore(
  guildId: string,
  parentChannelId: string,
  branchName: string,
  categoryId: string,
  deps: ForkTaskDeps,
  threadTitle?: string,
): Promise<ForkTaskResult> {
  const { stateManager, client, worktreesDir } = deps;

  const session = stateManager.getSession(guildId, parentChannelId);
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

  const newChannelName = threadTitle || `${session.name}/${branchName}`;

  // 验证 Category 存在
  const category = await client.channels.fetch(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error(`Category ${categoryId} not found or not a category`);
  }

  let textChannel;
  try {
    const guild = await client.guilds.fetch(guildId);
    textChannel = await guild.channels.create({
      name: newChannelName.slice(0, 100),
      type: ChannelType.GuildText,
      parent: categoryId,
      reason: `Fork task: ${branchName}`,
    });

    // 发送初始消息
    const embed = new EmbedBuilder()
      .setColor(EmbedColors.PURPLE)
      .setDescription(`[fork] Task created: \`${branchName}\`\nWorking directory: \`${worktreeDir}\``.slice(0, 4096));
    await textChannel.send({ embeds: [embed] });
  } catch (err) {
    // 回滚 worktree
    logger.warn(`Channel creation failed, rolling back worktree: ${worktreeDir}`);
    await removeWorktree(session.cwd, worktreeDir).catch(e =>
      logger.error(`Worktree rollback failed: ${e.message}`)
    );
    throw err;
  }

  const newChannelId = textChannel.id;
  stateManager.getOrCreateSession(guildId, newChannelId, {
    name: newChannelName,
    cwd: worktreeDir,
  });
  stateManager.setSessionForkInfo(guildId, newChannelId, parentChannelId, branchName);

  // 同步到 channels 表
  if (deps.channelService) {
    await deps.channelService.ensureChannel(newChannelId, guildId, newChannelName, worktreeDir, {
      parentChannelId: parentChannelId,
      worktreeBranch: branchName,
    });
  }

  return {
    channelId: newChannelId,
    channelName: newChannelName,
    branchName,
    cwd: worktreeDir,
  };
}
