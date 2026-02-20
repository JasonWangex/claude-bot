/**
 * POST /api/channels/:channelId/qdev — 快速创建开发任务
 *
 * 流程:
 * 1. 从 parentChannelId 找到 root session
 * 2. 生成分支名和 channel 标题
 * 3. Fork root task（worktree + Category Text Channel + session）
 * 4. 发送任务描述到新 channel
 * 5. 后台触发 Claude 处理
 * 6. 立即返回 202 Accepted
 */

import { ChannelType, EmbedBuilder } from 'discord.js';
import type { RouteHandler } from '../types.js';
import { sendJson, requireAuth, readJsonBody } from '../middleware.js';
import { EmbedColors } from '../../bot/message-queue.js';
import { forkTaskCore } from '../../utils/fork-task.js';
import { generateBranchName } from '../../utils/git-utils.js';
import { generateTopicTitle } from '../../utils/llm.js';
import { logger } from '../../utils/logger.js';
import { TaskRepo } from '../../db/repo/task-repo.js';
import { getDb } from '../../db/index.js';

// 模块级 lazy init（同 tasks.ts 中 getInteractionRepo 模式）
let taskRepo: TaskRepo | null = null;
function getTaskRepo(): TaskRepo {
  if (!taskRepo) taskRepo = new TaskRepo(getDb());
  return taskRepo;
}

export const qdev: RouteHandler = async (req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const channelId = params.channelId;
  const session = deps.stateManager.getSession(guildId, channelId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: 'Task not found' });
    return;
  }

  const body = await readJsonBody<{ description: string; category_id?: string }>(req);
  if (!body?.description || typeof body.description !== 'string') {
    sendJson(res, 400, { ok: false, error: '"description" field is required' });
    return;
  }

  const description = body.description.trim();

  // 需要 category_id 来创建新 channel
  let categoryId = body.category_id;
  if (!categoryId) {
    try {
      const channel = await deps.client.channels.fetch(channelId);
      if (channel && 'parentId' in channel && channel.parentId) {
        const parent = await deps.client.channels.fetch(channel.parentId);
        if (parent && parent.type === ChannelType.GuildCategory) {
          categoryId = parent.id;
        }
      }
    } catch { /* ignore */ }
  }
  if (!categoryId) {
    sendJson(res, 400, { ok: false, error: '"category_id" required or channel must be in a Category' });
    return;
  }

  try {
    // 1. 并行生成分支名和 channel 标题
    const [branchName, threadTitle] = await Promise.all([
      generateBranchName(description),
      generateTopicTitle(description),
    ]);

    // 2. 找到 root session
    const rootSession = deps.stateManager.getRootSession(guildId, channelId);
    const parentChannelId = rootSession?.channelId ?? channelId;

    // 3. Fork
    const forkResult = await forkTaskCore(guildId, parentChannelId, branchName, categoryId, {
      stateManager: deps.stateManager,
      client: deps.client,
      worktreesDir: deps.config.worktreesDir,
      channelService: deps.channelService,
    }, threadTitle);

    // 3b. 保存 task 到数据库（goal_id=null 表示独立任务）
    const repo = getTaskRepo();
    await repo.save({
      id: forkResult.channelId,       // channel ID 作为 task ID
      description,
      type: '代码',
      depends: [],
      status: 'dispatched',
      branchName: forkResult.branchName,
      channelId: forkResult.channelId,
      dispatchedAt: Date.now(),
    }, null);  // goalId = null（独立任务）

    // 4. 发送任务描述到新 channel
    const newChannel = await deps.client.channels.fetch(forkResult.channelId);
    if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
      const descEmbed = new EmbedBuilder()
        .setColor(EmbedColors.PURPLE)
        .setDescription(`[qdev] ${description}`.slice(0, 4096));
      await (newChannel as any).send({ embeds: [descEmbed] });
    }

    // 5. 立即返回
    sendJson(res, 202, {
      ok: true,
      data: {
        channel_id: forkResult.channelId,
        name: forkResult.channelName,
        branch: forkResult.branchName,
        cwd: forkResult.cwd,
        parent_channel_id: parentChannelId,
        status: 'accepted',
      },
    });

    // 6. 后台触发 Claude
    (async () => {
      try {
        logger.info(`[qdev] Background chat started for channel ${forkResult.channelId}`);
        await deps.messageHandler.handleBackgroundChat(guildId, forkResult.channelId, description);
        logger.info(`[qdev] Background chat completed for channel ${forkResult.channelId}`);
      } catch (error: any) {
        logger.error(`[qdev] Background chat failed for channel ${forkResult.channelId}:`, error.message);
        await deps.mq.sendLong(forkResult.channelId, `Error: ${error.message}`, { silent: true }).catch(() => {});
      }
    })();
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: `qdev failed: ${error.message}` });
  }
};
