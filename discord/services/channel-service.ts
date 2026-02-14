/**
 * ChannelService — Channel 业务层服务
 *
 * 封装 Channel + ClaudeSession 的业务逻辑，提供幂等的通道管理、会话管理、
 * 虚拟通道创建等核心功能。
 */

import { randomUUID } from 'node:crypto';
import type { IChannelRepo, IClaudeSessionRepo, ISyncCursorRepo } from '../types/repository.js';
import type { Channel, ClaudeSession } from '../types/index.js';
import type { GuildChannel } from 'discord.js';

/**
 * ensureChannel 可选参数
 */
export interface EnsureChannelOptions {
  parentChannelId?: string;
  worktreeBranch?: string;
}

/**
 * ChannelService 核心业务服务
 */
export class ChannelService {
  constructor(
    private channelRepo: IChannelRepo,
    private claudeSessionRepo: IClaudeSessionRepo,
    private syncCursorRepo: ISyncCursorRepo,
  ) {}

  // ==================== Channel 管理 ====================

  /**
   * 幂等确保 Channel 存在
   *
   * - 如果 Channel 已存在且 status='archived'，自动 restore
   * - 如果 Channel 不存在，创建新记录
   * - 返回 Channel 实体
   */
  async ensureChannel(
    channelId: string,
    guildId: string,
    name: string,
    cwd: string,
    opts?: EnsureChannelOptions,
  ): Promise<Channel> {
    const existing = await this.channelRepo.get(channelId);

    if (existing) {
      // 已存在，检查是否需要 restore
      if (existing.status === 'archived') {
        await this.channelRepo.restore(channelId);
        // 重新读取
        const restored = await this.channelRepo.get(channelId);
        return restored!;
      }
      return existing;
    }

    // 不存在，创建新 Channel
    const newChannel: Channel = {
      id: channelId,
      guildId,
      name,
      cwd,
      worktreeBranch: opts?.worktreeBranch,
      parentChannelId: opts?.parentChannelId,
      status: 'active',
      messageCount: 0,
      createdAt: Date.now(),
    };

    await this.channelRepo.save(newChannel);
    return newChannel;
  }

  /**
   * 归档 Channel
   *
   * - 调用 channelRepo.archive()
   * - 关闭关联的活跃 ClaudeSession
   * - 返回是否成功归档
   */
  async archiveChannel(channelId: string, userId?: string, reason?: string): Promise<boolean> {
    const success = await this.channelRepo.archive(channelId, userId, reason);
    if (!success) return false;

    // 关闭活跃的 ClaudeSession
    await this.closeActiveSession(channelId);

    return true;
  }

  /**
   * 获取 Guild 下所有活跃 Channel
   */
  async getActiveChannels(guildId: string): Promise<Channel[]> {
    return this.channelRepo.getByGuildAndStatus(guildId, 'active');
  }

  /**
   * 创建后端虚拟通道
   *
   * - ID 格式：`virtual-${randomUUID()}`（与 Discord snowflake 明确区分）
   * - 不创建 Discord Channel
   * - 写入 channels 表
   */
  async createVirtualChannel(guildId: string, name: string, cwd: string): Promise<Channel> {
    const virtualId = `virtual-${randomUUID()}`;

    const channel: Channel = {
      id: virtualId,
      guildId,
      name,
      cwd,
      status: 'active',
      messageCount: 0,
      createdAt: Date.now(),
    };

    await this.channelRepo.save(channel);
    return channel;
  }

  /**
   * 从 Discord GuildChannel 对象同步到 DB
   *
   * - 提取 id, guild.id, name, parentId 等
   * - upsert 到 channels 表
   * - 返回 Channel 实体
   */
  async syncFromDiscord(discordChannel: GuildChannel): Promise<Channel> {
    const channelId = discordChannel.id;
    const guildId = discordChannel.guild.id;
    const name = discordChannel.name;

    // 读取已有记录，保留 cwd / worktreeBranch / parentChannelId
    const existing = await this.channelRepo.get(channelId);

    const channel: Channel = {
      id: channelId,
      guildId,
      name,
      cwd: existing?.cwd ?? '/default', // 如果没有记录，使用默认值
      worktreeBranch: existing?.worktreeBranch,
      parentChannelId: discordChannel.parentId ?? undefined,
      status: existing?.status ?? 'active',
      archivedAt: existing?.archivedAt,
      archivedBy: existing?.archivedBy,
      archiveReason: existing?.archiveReason,
      messageCount: existing?.messageCount ?? 0,
      createdAt: existing?.createdAt ?? Date.now(),
      lastMessage: existing?.lastMessage,
      lastMessageAt: existing?.lastMessageAt,
    };

    await this.channelRepo.save(channel);
    return channel;
  }

  // ==================== ClaudeSession 管理 ====================

  /**
   * 获取或创建活跃 ClaudeSession
   *
   * - 查询 claudeSessionRepo.getActiveByChannel()
   * - 不存在则创建新 ClaudeSession（UUID + channelId + status=active）
   * - 返回 ClaudeSession
   */
  async getOrCreateClaudeSession(channelId: string): Promise<ClaudeSession> {
    const existing = await this.claudeSessionRepo.getActiveByChannel(channelId);
    if (existing) return existing;

    // 创建新 session
    const newSession: ClaudeSession = {
      id: randomUUID(),
      channelId,
      planMode: false,
      status: 'active',
      createdAt: Date.now(),
    };

    await this.claudeSessionRepo.save(newSession);
    return newSession;
  }

  /**
   * 关闭 Channel 当前活跃 session
   */
  async closeActiveSession(channelId: string): Promise<boolean> {
    const activeSession = await this.claudeSessionRepo.getActiveByChannel(channelId);
    if (!activeSession) return false;

    return this.claudeSessionRepo.close(activeSession.id);
  }

  /**
   * Claude CLI 返回后更新 claude_session_id
   */
  async updateClaudeSessionId(localSessionId: string, claudeSessionId: string): Promise<void> {
    const session = await this.claudeSessionRepo.get(localSessionId);
    if (!session) return;

    session.claudeSessionId = claudeSessionId;
    await this.claudeSessionRepo.save(session);
  }
}
