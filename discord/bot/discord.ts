/**
 * Discord Bot 初始化（Guild + Category/Channels 模式）
 */

import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Events,
  ChannelType,
} from 'discord.js';
import { StateManager } from './state.js';
import { InteractionRegistry } from './interaction-registry.js';
import { MessageQueue, EmbedColors } from './message-queue.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { DiscordBotConfig, ClaudeErrorType, ClaudeExecutionError } from '../types/index.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';
import { DiscordTransport } from '../utils/transports/discord-transport.js';
import { ApiServer } from '../api/server.js';
import { GoalOrchestrator } from '../orchestrator/index.js';
import { parseGoalButtonId, GOAL_MODAL_PREFIX, buildApproveWithModsModal } from '../orchestrator/goal-buttons.js';
import { parseIdeaButtonId, buildIdeaAdvanceChoiceButtons } from './idea-buttons.js';
import { generateBranchName } from '../utils/git-utils.js';
import { generateTopicTitle } from '../utils/llm.js';
import { forkTaskCore } from '../utils/fork-task.js';
import { initDb, getDb, closeDb } from '../db/index.js';
import { GoalRepo, TaskRepo, CheckpointRepo } from '../db/repo/index.js';
import { GoalMetaRepo } from '../db/goal-meta-repo.js';
import { GoalTodoRepository } from '../db/goal-todo-repo.js';
import { TaskEventRepo } from '../db/repo/task-event-repo.js';
import { GoalTimelineRepo } from '../db/repo/goal-timeline-repo.js';
import { GoalEventRepo } from '../db/repo/goal-event-repo.js';
import { IdeaRepository } from '../db/idea-repo.js';
import { GuildRepository } from '../db/repo/guild-repo.js';
import { ChannelRepository } from '../db/repo/channel-repo.js';
import { ClaudeSessionRepository } from '../db/repo/claude-session-repo.js';
import { ChannelSessionLinkRepository } from '../db/repo/channel-session-link-repo.js';
import { SyncCursorRepository } from '../db/repo/sync-cursor-repo.js';
import { ChannelService } from '../services/channel-service.js';
import { getAuthorizedGuildId, getGeneralChannelId } from '../utils/env.js';
import { AuthErrorInterceptor } from '../claude/auth-error-interceptor.js';
import { escapeMarkdown } from './message-utils.js';
import { registerSlashCommands, routeCommand } from './commands/index.js';
import { SessionSyncService } from '../sync/session-sync-service.js';
import { PricingService } from '../sync/pricing-service.js';
import { UsageReconciler } from '../sync/usage-reconciler.js';
import { join } from 'path';
import { MODEL_OPTIONS, getModelLabel } from './commands/task.js';
import type { CommandDeps } from './commands/types.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';

export class DiscordBot {
  private client: Client;
  private stateManager: StateManager;
  private interactionRegistry: InteractionRegistry;
  private messageQueue: MessageQueue;
  private messageHandler: MessageHandler;
  private claudeClient: ClaudeClient;
  private config: DiscordBotConfig;
  private promptService: PromptConfigService;
  private apiServer: ApiServer | null = null;
  private orchestrator: GoalOrchestrator | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private sessionSyncService: SessionSyncService;
  private pricingService: PricingService;
  private usageReconciler: UsageReconciler;
  private channelService: ChannelService | null = null;

  constructor(config: DiscordBotConfig, promptService: PromptConfigService) {
    this.config = config;
    this.promptService = promptService;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    const db = initDb();
    const guildRepo = new GuildRepository(db);
    const channelRepo = new ChannelRepository(db);
    const claudeSessionRepo = new ClaudeSessionRepository(db);
    const linkRepo = new ChannelSessionLinkRepository(db);
    const syncCursorRepo = new SyncCursorRepository(db);

    this.channelService = new ChannelService(channelRepo, claudeSessionRepo, syncCursorRepo);
    this.stateManager = new StateManager(config.defaultWorkDir, guildRepo, channelRepo, claudeSessionRepo, db, linkRepo);
    this.interactionRegistry = new InteractionRegistry();
    this.claudeClient = new ClaudeClient(
      config.claudeCliPath,
      config.commandTimeout,
      config.maxTurns,
      config.stallTimeout,
    );
    this.messageQueue = new MessageQueue(this.client);
    this.messageHandler = new MessageHandler(this.stateManager, this.claudeClient, this.interactionRegistry, this.messageQueue);
    this.messageHandler.setErrorReporter((guildId, channelId, source, error) => this.sendErrorToGeneral(guildId, channelId, source, error));

    // 初始化 PricingService + SessionSyncService + UsageReconciler
    this.pricingService = new PricingService();
    const claudeProjectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
    this.sessionSyncService = new SessionSyncService(db, claudeProjectsDir, this.pricingService);
    this.sessionSyncService.setPromptService(promptService);
    this.usageReconciler = new UsageReconciler(db, claudeProjectsDir, this.pricingService);

    // 注入 executor 回调
    this.claudeClient.setSessionSyncCallback((sessionId, channelId, model) => {
      this.sessionSyncService.syncSession(sessionId, channelId, model);
    });

    // 注入 session close 回调（进程中止/杀死时触发）
    this.claudeClient.setSessionCloseCallback((sessionId) => {
      this.sessionSyncService.closeSession(sessionId);
    });

    // 配置全局 logger transports
    this.setupLogger();

    this.registerHandlers();

    // 定期清理
    this.cleanupInterval = setInterval(() => {
      this.stateManager.cleanup();
      this.interactionRegistry.cleanup();
    }, 60 * 60 * 1000);
  }

  private setupLogger(): void {
    // 如果配置了 Bot Logs Channel，添加 Discord Transport
    // 注意：ConsoleTransport 已在 logger.ts 全局初始化时添加，此处不需要重复添加
    if (this.config.botLogsChannelId) {
      const discordTransport = new DiscordTransport({
        messageQueue: this.messageQueue,
        channelId: this.config.botLogsChannelId,
        minLevel: 'info', // 只记录 info 及以上级别的日志到 Discord
      });
      logger.addTransport(discordTransport);
    }
  }

  private getCommandDeps(): CommandDeps {
    return {
      stateManager: this.stateManager,
      claudeClient: this.claudeClient,
      client: this.client,
      config: this.config,
      messageHandler: this.messageHandler,
      messageQueue: this.messageQueue,
      channelService: this.channelService ?? undefined,
      promptService: this.promptService,
    };
  }

  private registerHandlers(): void {
    // Bot ready
    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info(`Discord Bot logged in as ${readyClient.user.tag}`);
    });

    // Slash Command 路由
    this.client.on(Events.InteractionCreate, async (interaction) => {
      // Slash Commands
      if (interaction.isChatInputCommand()) {
        try {
          await routeCommand(interaction, this.getCommandDeps());
        } catch (err: any) {
          logger.error(`Command /${interaction.commandName} error:`, err);
          const reply = { content: 'An error occurred while processing this command.', ephemeral: true };
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply).catch(() => {});
          } else {
            await interaction.reply(reply).catch(() => {});
          }
        }
        return;
      }

      // StringSelectMenu 交互
      if (interaction.isStringSelectMenu()) {
        await this.handleSelectMenu(interaction);
        return;
      }

      // Button 交互
      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }

      // Modal 提交
      if (interaction.isModalSubmit()) {
        await this.handleModalSubmit(interaction);
        return;
      }
    });

    // 文字消息 → Claude 对话（仅有 session 的 task channels）
    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (!message.guildId) return;
      if (!checkAuth(message.guildId)) return;

      const channel = message.channel;
      const channelId = channel.id;

      // 用 session 存在性判断是否为 task channel
      if (!this.stateManager.getSession(message.guildId, channelId)) return;

      // 检查是否在等待自定义文本输入（Modal 替代方案：直接文本消息）
      const waitingEntry = this.interactionRegistry.findWaitingCustomText(message.guildId, channelId);
      if (waitingEntry) {
        let resolveText = message.content;
        // 兼容 Discord 将长文本自动转为文件的情况
        const textFile = message.attachments.find(
          a => a.contentType?.startsWith('text/plain') || a.name?.endsWith('.txt'),
        );
        if (textFile) {
          const fileContent = await MessageHandler.downloadTextFile(textFile.url);
          if (fileContent !== null) {
            resolveText = resolveText ? `${resolveText}\n${fileContent}` : fileContent;
          }
        }
        if (!resolveText) return;
        this.interactionRegistry.resolve(waitingEntry.toolUseId, resolveText);
        await message.react('✅').catch(() => {});
        return;
      }

      // 处理图片附件
      const imageAttachments = message.attachments.filter(a => a.contentType?.startsWith('image/'));
      if (imageAttachments.size > 0) {
        this.messageHandler.handlePhoto(message).catch((err) => {
          logger.error('Photo handler error:', err);
        });
        return;
      }

      // 文字消息 → Claude 对话流
      this.messageHandler.handleText(message).catch((err) => {
        logger.error('Text handler error:', err);
        channel.send(`Error processing message. Check #general for details.`).catch(() => {});
        this.sendErrorToGeneral(message.guildId ?? undefined, channelId, 'Text handler', err);
      });
    });

    this.client.on(Events.Error, (err) => {
      logger.error('Discord client error:', err);
    });

    // Discord Channel 事件同步（同步到 channels 表）
    this.client.on(Events.ChannelCreate, async (channel) => {
      if (!channel.guild || !checkAuth(channel.guild.id)) return;
      if (channel.type !== ChannelType.GuildText) return;
      if (!this.channelService) return;
      try {
        await this.channelService.syncFromDiscord(channel);
        logger.info(`Channel created: ${channel.name} (${channel.id})`);
      } catch (err: any) {
        logger.error('ChannelCreate sync error:', err);
      }
    });

    this.client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
      if (newChannel.type !== ChannelType.GuildText) return;
      if (!('guild' in newChannel) || !newChannel.guild || !checkAuth(newChannel.guild.id)) return;
      if (!this.channelService) return;
      try {
        await this.channelService.syncFromDiscord(newChannel);
        logger.info(`Channel updated: ${newChannel.name} (${newChannel.id})`);
      } catch (err: any) {
        logger.error('ChannelUpdate sync error:', err);
      }
    });

    this.client.on(Events.ChannelDelete, async (channel) => {
      if (!('guild' in channel) || !channel.guild || !checkAuth(channel.guild.id)) return;
      if (!this.channelService) return;
      try {
        await this.channelService.archiveChannel(channel.id, undefined, 'Discord channel deleted');
        logger.info(`Channel deleted: ${channel.id}`);
      } catch (err: any) {
        logger.error('ChannelDelete archive error:', err);
      }
    });
  }

  // ========== Component Interaction Handlers ==========

  private async handleSelectMenu(interaction: any): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId || !checkAuth(guildId)) {
      await interaction.reply({ content: 'Unauthorized', ephemeral: true }).catch(() => {});
      return;
    }

    const customId = interaction.customId;
    const selected = interaction.values[0];

    // 全局模型切换
    if (customId === 'gmodel_select') {
      const model = selected === 'default' ? undefined : selected;
      this.stateManager.setGuildDefaultModel(guildId, model);
      const label = getModelLabel(model);
      await interaction.update({
        content: `Global default model set to: **${label}**`,
        components: [],
      });
      return;
    }

    // Thread 模型切换
    if (customId === 'model_select') {
      const channelId = interaction.channelId;
      const model = selected === 'follow_default' ? undefined : selected;
      this.stateManager.setSessionModel(guildId, channelId, model);
      const label = model ? getModelLabel(model) : `${getModelLabel(this.stateManager.getGuildDefaultModel(guildId))} (follow default)`;
      await interaction.update({
        content: `Model set to: **${label}**`,
        components: [],
      });
      return;
    }

    // AskUserQuestion SelectMenu（以 input: 开头）
    if (customId.startsWith('input:')) {
      const prefix = customId.slice('input:'.length);
      const entry = this.interactionRegistry.findByPrefix(prefix);
      if (!entry) {
        await interaction.reply({ content: 'This interaction has expired.', ephemeral: true }).catch(() => {});
        return;
      }
      const label = entry.options?.[parseInt(selected, 10)] || selected;
      this.interactionRegistry.resolve(entry.toolUseId, label);
      await interaction.update({
        content: `Selected: **${label}**`,
        components: [],
      }).catch(() => {});
      return;
    }
  }

  private async handleButton(interaction: any): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId || !checkAuth(guildId)) {
      await interaction.reply({ content: 'Unauthorized', ephemeral: true }).catch(() => {});
      return;
    }

    const customId = interaction.customId;
    const channelId = interaction.channelId;

    // 用户交互时取消待发的等待消息
    if (channelId) {
      this.stateManager.cancelWaitingMessage(channelId);
    }

    // Stop button: stop:<lockKey>
    if (customId.startsWith('stop:')) {
      const lockKey = customId.slice('stop:'.length);
      const wasRunning = this.claudeClient.abort(lockKey);
      await interaction.reply({
        content: wasRunning ? 'Stopping...' : 'No running task.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    // Cancel button: cancel:<lockKeyPrefix>
    // 只取消排队中的消息，不杀运行中的进程
    if (customId.startsWith('cancel:')) {
      const lockKeyPrefix = customId.slice('cancel:'.length);
      const result = this.claudeClient.cancelQueued(lockKeyPrefix);
      let content: string;
      if (result.cancelled > 0) {
        content = `Cancelled ${result.cancelled} queued message(s).`;
      } else if (result.hasRunning) {
        content = 'No queued messages. Task is running — use /stop to stop it.';
      } else {
        content = 'Nothing to cancel.';
      }
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
      return;
    }

    // Interrupt button: interrupt:<lockKeyPrefix>
    // 只杀运行中的进程，队列中的消息自然获得锁继续执行
    if (customId.startsWith('interrupt:')) {
      const lockKeyPrefix = customId.slice('interrupt:'.length);
      const result = this.claudeClient.abortRunning(lockKeyPrefix);
      await interaction.reply({
        content: result.aborted ? 'Interrupting current task...' : 'No running task to interrupt.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    // Goal orchestrator buttons: goal:<action>:<goalId>[:<extra>]
    if (customId.startsWith('goal:')) {
      await this.handleGoalButton(interaction);
      return;
    }

    // Idea buttons: idea:<action>:<ideaId>
    if (customId.startsWith('idea:')) {
      await this.handleIdeaButton(interaction);
      return;
    }

    // Sessions buttons: sessions:<action>:<param>
    if (customId.startsWith('sessions:')) {
      await this.handleSessionsButton(interaction);
      return;
    }

    // AskUserQuestion / ExitPlanMode buttons: input:<prefix>:<selection>
    if (customId.startsWith('input:')) {
      const parts = customId.split(':');
      if (parts.length < 3) return;
      const prefix = parts[1];
      const selection = parts.slice(2).join(':');

      const entry = this.interactionRegistry.findByPrefix(prefix);
      if (!entry) {
        await interaction.reply({ content: 'This interaction has expired.', ephemeral: true }).catch(() => {});
        return;
      }

      if (selection === 'other') {
        // 标记等待自定义文本输入
        this.interactionRegistry.setWaitingCustomText(entry.toolUseId, true);
        await interaction.update({
          content: 'Please type your reply directly:',
          components: [],
        }).catch(() => {});
        return;
      }

      if (selection === 'approve') {
        this.interactionRegistry.resolve(entry.toolUseId, 'approve');
        await interaction.update({ content: 'Plan approved', components: [] }).catch(() => {});
        return;
      }

      if (selection === 'compact_execute') {
        this.interactionRegistry.resolve(entry.toolUseId, 'compact_execute');
        await interaction.update({ content: 'Compacting context and executing plan...', components: [] }).catch(() => {});
        return;
      }

      if (selection === 'reject') {
        this.interactionRegistry.resolve(entry.toolUseId, 'reject');
        await interaction.update({ content: 'Plan rejected', components: [] }).catch(() => {});
        return;
      }

      // Numeric index → option label
      const index = parseInt(selection, 10);
      if (!isNaN(index)) {
        const label = this.interactionRegistry.getOptionLabel(entry.toolUseId, index);
        const answer = label || `option_${index}`;
        this.interactionRegistry.resolve(entry.toolUseId, answer);
        await interaction.update({
          content: `Selected: **${answer}**`,
          components: [],
        }).catch(() => {});
        return;
      }
    }
  }

  /**
   * 处理 Goal 按钮交互
   * customId 格式: goal:<action>:<goalId>[:<extra>]
   */
  private async handleGoalButton(interaction: any): Promise<void> {
    const parsed = parseGoalButtonId(interaction.customId);
    if (!parsed) return;

    const { action, goalId, extra } = parsed;

    // drive_prompt 不需要 orchestrator，直接加载 skill 转发给 Claude
    if (action === 'drive_prompt') {
      await this.handleGoalDrivePrompt(interaction, goalId);
      return;
    }

    // 以下操作均需要 orchestrator
    if (!this.orchestrator) {
      await interaction.reply({ content: 'Orchestrator not available', ephemeral: true }).catch(() => {});
      return;
    }

    try {
      switch (action) {
        case 'approve_replan': {
          await interaction.update({ content: '\u23F3 正在执行计划变更...', components: [] }).catch(() => {});
          const ok = await this.orchestrator.approveReplan(goalId);
          if (!ok) {
            await interaction.followUp({ content: '没有待审批的计划变更', ephemeral: true }).catch(() => {});
          }
          break;
        }

        case 'reject_replan': {
          await interaction.update({ content: '\u{1F6AB} 已拒绝计划变更', components: [] }).catch(() => {});
          await this.orchestrator.rejectReplan(goalId);
          break;
        }

        case 'approve_with_mods': {
          // 获取当前待审批变更的 JSON，预填到 Modal 中
          const pendingChangesJson = await this.orchestrator.getPendingReplanChangesJson(goalId);
          if (!pendingChangesJson) {
            await interaction.reply({ content: '没有待审批的计划变更', ephemeral: true }).catch(() => {});
            return;
          }
          const modal = buildApproveWithModsModal(goalId, pendingChangesJson);
          await interaction.showModal(modal);
          break;
        }

        case 'rollback': {
          if (!extra) {
            await interaction.reply({ content: '缺少检查点 ID', ephemeral: true }).catch(() => {});
            return;
          }
          await interaction.update({ content: '\u23F3 正在评估回滚成本...', components: [] }).catch(() => {});
          const pending = await this.orchestrator.rollback(goalId, extra);
          if (!pending) {
            await interaction.followUp({ content: '回滚评估失败，请查看 Goal thread', ephemeral: true }).catch(() => {});
          }
          break;
        }

        case 'confirm_rollback': {
          await interaction.update({ content: '\u23F3 正在执行回滚...', components: [] }).catch(() => {});
          const ok = await this.orchestrator.confirmRollback(goalId);
          if (!ok) {
            await interaction.followUp({ content: '回滚执行失败', ephemeral: true }).catch(() => {});
          }
          break;
        }

        case 'cancel_rollback': {
          await interaction.update({ content: '\u{1F6AB} 已取消回滚', components: [] }).catch(() => {});
          await this.orchestrator.cancelRollback(goalId);
          break;
        }

        case 'retry_task': {
          if (!extra) return;
          await interaction.update({ content: '🔄 正在重试...', components: [] }).catch(() => {});
          const ok = await this.orchestrator.retryTask(goalId, extra);
          if (!ok) {
            await interaction.followUp({ content: '任务不在可重试状态', ephemeral: true }).catch(() => {});
          }
          break;
        }

        case 'refix_task': {
          if (!extra) return;
          await interaction.update({ content: '🔧 正在重新修复...', components: [] }).catch(() => {});
          const ok = await this.orchestrator.refixTask(goalId, extra);
          if (!ok) {
            await interaction.followUp({ content: '任务不在可修复状态（需要 failed 且有上下文）', ephemeral: true }).catch(() => {});
          }
          break;
        }

        case 'skip_task': {
          if (!extra) return;
          await interaction.update({ content: '⏭ 正在跳过任务...', components: [] }).catch(() => {});
          const ok = await this.orchestrator.skipTask(goalId, extra);
          if (!ok) {
            await interaction.followUp({ content: '任务不在可跳过状态', ephemeral: true }).catch(() => {});
          }
          break;
        }

        case 'replan_task': {
          if (!extra) return;
          await interaction.update({ content: '📋 正在触发重规划...', components: [] }).catch(() => {});
          const ok = await this.orchestrator.replanFromTask(goalId, extra);
          if (!ok) {
            await interaction.followUp({ content: '无法触发重规划', ephemeral: true }).catch(() => {});
          }
          break;
        }

        default:
          await interaction.reply({ content: `Unknown goal action: ${action}`, ephemeral: true }).catch(() => {});
      }
    } catch (err: any) {
      logger.error('[DiscordBot] handleGoalButton error:', err);
      // 尽量回复用户，避免 Discord 显示 "interaction failed"
      const reply = interaction.replied || interaction.deferred
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `操作失败: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  /**
   * Goal 列表「推进」按钮：加载 goal skill 转发给 Claude
   */
  private async handleGoalDrivePrompt(interaction: any, goalId: string): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = interaction.channelId;

    try {
      await interaction.update({ content: '正在准备推进 Goal...', components: [] }).catch(() => {});

      const db = getDb();
      const goalMetaRepo = new GoalMetaRepo(db);
      const goal = await goalMetaRepo.get(goalId);
      if (!goal) {
        await interaction.followUp({ content: 'Goal not found', ephemeral: true }).catch(() => {});
        return;
      }

      // 通过原生 skill 触发 goal
      const prompt = `/goal ${goal.name}`;
      this.messageHandler.handleBackgroundChat(guildId, channelId, prompt).catch((err) => {
        logger.error('goal drive_prompt failed:', err);
        this.messageQueue.sendLong(channelId, `goal drive_prompt failed: ${err.message}`).catch(() => {});
      });
    } catch (err: any) {
      logger.error('[DiscordBot] handleGoalDrivePrompt error:', err);
      const reply = interaction.replied || interaction.deferred
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `操作失败: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  /**
   * 处理 Idea 按钮交互
   * customId 格式: idea:<action>:<ideaId>
   */
  private async handleIdeaButton(interaction: any): Promise<void> {
    const parsed = parseIdeaButtonId(interaction.customId);
    if (!parsed) return;

    const { action, ideaId } = parsed;
    const guildId = interaction.guildId!;
    const channelId = interaction.channelId;

    try {
      switch (action) {
        case 'promote': {
          // 第一步：展示推进方式选择按钮
          const db0 = getDb();
          const ideaRepo0 = new IdeaRepository(db0);
          const idea0 = await ideaRepo0.get(ideaId);
          if (!idea0) {
            await interaction.update({ content: 'Idea not found', components: [] }).catch(() => {});
            return;
          }

          const choiceRows = buildIdeaAdvanceChoiceButtons(ideaId);
          await interaction.update({
            content: `**${escapeMarkdown(idea0.name)}**\n选择推进方式：`,
            components: choiceRows,
          }).catch(() => {});
          break;
        }

        case 'qdev': {
          // 快速开发：纯代码流程（复用 /qdev 逻辑）
          await interaction.update({ content: '正在启动快速开发...', components: [] }).catch(() => {});

          const db = getDb();
          const ideaRepo = new IdeaRepository(db);
          const idea = await ideaRepo.get(ideaId);
          if (!idea) {
            await interaction.followUp({ content: 'Idea not found', ephemeral: true }).catch(() => {});
            return;
          }

          // 标记为 Processing
          idea.status = 'Processing';
          idea.updatedAt = Date.now();
          await ideaRepo.save(idea);

          // 并行生成分支名和标题
          const [branchName, threadTitle] = await Promise.all([
            generateBranchName(idea.name),
            generateTopicTitle(idea.name),
          ]);

          // 获取 root session 和 categoryId
          const rootSession = this.stateManager.getRootSession(guildId, channelId);
          const parentChannelId = rootSession?.channelId ?? channelId;

          const channel = interaction.channel;
          let categoryId: string | undefined;
          if (channel && 'parentId' in channel && channel.parentId) {
            const parent = await this.client.channels.fetch(channel.parentId);
            if (parent && parent.type === ChannelType.GuildCategory) {
              categoryId = parent.id;
            }
          }
          if (!categoryId) {
            await interaction.followUp({ content: 'This command must be used in a task channel (under a Category).', ephemeral: true }).catch(() => {});
            return;
          }

          // Fork: 创建 worktree + channel + session
          const forkResult = await forkTaskCore(guildId, parentChannelId, branchName, categoryId, {
            stateManager: this.stateManager,
            client: this.client,
            worktreesDir: this.config.worktreesDir,
            channelService: this.channelService ?? undefined,
          }, threadTitle);

          // 发送任务描述到新 channel
          const newChannel = await this.client.channels.fetch(forkResult.channelId);
          if (newChannel && newChannel.isTextBased() && 'send' in newChannel) {
            const descEmbed = new EmbedBuilder()
              .setColor(EmbedColors.PURPLE)
              .setDescription(`[idea→qdev] ${idea.name}`.slice(0, 4096));
            await (newChannel as any).send({ embeds: [descEmbed] });
          }

          // 触发 Claude 处理
          this.messageHandler.handleBackgroundChat(guildId, forkResult.channelId, idea.name).catch((err) => {
            logger.error('idea qdev failed:', err);
            this.messageQueue.sendLong(forkResult.channelId, `idea qdev failed: ${err.message}`).catch(() => {});
          });

          // 回复确认
          await interaction.followUp({
            content: `**Idea → Dev**\nBranch: \`${forkResult.branchName}\`\nChannel: <#${forkResult.channelId}>`,
          }).catch(() => {});
          break;
        }

        case 'goal': {
          // 推进为 Goal：加载 goal skill，传入 idea 名称进入创建模式
          await interaction.update({ content: '正在推进为 Goal...', components: [] }).catch(() => {});

          const db = getDb();
          const ideaRepo = new IdeaRepository(db);
          const idea = await ideaRepo.get(ideaId);
          if (!idea) {
            await interaction.followUp({ content: 'Idea not found', ephemeral: true }).catch(() => {});
            return;
          }

          idea.status = 'Processing';
          idea.updatedAt = Date.now();
          await ideaRepo.save(idea);

          const goalPrompt = `/goal ${idea.name}`;
          this.messageHandler.handleBackgroundChat(guildId, channelId, goalPrompt).catch((err) => {
            logger.error('idea to goal failed:', err);
            this.messageQueue.sendLong(channelId, `idea to goal failed: ${err.message}`).catch(() => {});
          });
          break;
        }

        default:
          await interaction.reply({ content: `Unknown idea action: ${action}`, ephemeral: true }).catch(() => {});
      }
    } catch (err: any) {
      logger.error('[DiscordBot] handleIdeaButton error:', err);
      const reply = interaction.replied || interaction.deferred
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `操作失败: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  /**
   * 处理 /sessions 按钮交互
   * customId 格式: sessions:<action>:<param>
   */
  private async handleSessionsButton(interaction: any): Promise<void> {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) return;

    const parts = interaction.customId.split(':');
    const action = parts[1];

    try {
      if (action === 'switch') {
        // sessions:switch:<cliSessionIdPrefix>
        const cliIdPrefix = parts[2];
        // 查找完整的 CLI session ID
        const activeLinks = this.stateManager.getActiveLinks(channelId);
        const targetLink = activeLinks.find(l => l.claudeSessionId?.startsWith(cliIdPrefix));
        if (!targetLink?.claudeSessionId) {
          await interaction.reply({ content: 'Session not found.', ephemeral: true }).catch(() => {});
          return;
        }

        const result = this.stateManager.attachSession(guildId, channelId, targetLink.claudeSessionId);
        await interaction.update({
          content: `Switched to session \`${targetLink.claudeSessionId.slice(0, 8)}...\``,
          components: [],
        }).catch(() => {});
      } else if (action === 'cleanup') {
        // sessions:cleanup:<channelId> — 只保留 current session 的 link
        const session = this.stateManager.getSession(guildId, channelId);
        const activeLinks = this.stateManager.getActiveLinks(channelId);

        if (!session?.claudeSessionId || activeLinks.length <= 1) {
          await interaction.reply({ content: 'Nothing to clean up.', ephemeral: true }).catch(() => {});
          return;
        }

        // unlink 所有非 current 的 link
        let cleaned = 0;
        for (const link of activeLinks) {
          if (link.claudeSessionId !== session.claudeSessionId) {
            this.stateManager.unlinkSession(channelId, link.claudeSessionId);
            cleaned++;
          }
        }

        await interaction.update({
          content: `Cleaned up ${cleaned} stale link(s). Current session: \`${session.claudeSessionId.slice(0, 8)}...\``,
          components: [],
        }).catch(() => {});
      }
    } catch (err: any) {
      logger.error('[DiscordBot] handleSessionsButton error:', err);
      const reply = interaction.replied || interaction.deferred
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `Error: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  private async handleModalSubmit(interaction: any): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId || !checkAuth(guildId)) return;

    const customId = interaction.customId;

    // Goal orchestrator modal: goal_modal:<action>:<goalId>
    if (customId.startsWith(GOAL_MODAL_PREFIX)) {
      await this.handleGoalModalSubmit(interaction);
      return;
    }

    // Modal for custom text: modal:<prefix>
    if (customId.startsWith('modal:')) {
      const prefix = customId.slice('modal:'.length);
      const entry = this.interactionRegistry.findByPrefix(prefix);
      if (!entry) {
        await interaction.reply({ content: 'This interaction has expired.', ephemeral: true }).catch(() => {});
        return;
      }

      const text = interaction.fields.getTextInputValue('custom_text');
      this.interactionRegistry.resolve(entry.toolUseId, text);
      await interaction.reply({ content: `Submitted: ${text.slice(0, 100)}...`, ephemeral: true }).catch(() => {});
    }
  }

  /**
   * 处理 Goal orchestrator modal 提交
   * customId 格式: goal_modal:<action>:<goalId>
   */
  private async handleGoalModalSubmit(interaction: any): Promise<void> {
    if (!this.orchestrator) {
      await interaction.reply({ content: 'Orchestrator not available', ephemeral: true }).catch(() => {});
      return;
    }

    const customId = interaction.customId as string;
    const parts = customId.slice(GOAL_MODAL_PREFIX.length).split(':');
    const action = parts[0];
    const goalId = parts[1];

    if (!goalId) {
      await interaction.reply({ content: 'Invalid modal submission', ephemeral: true }).catch(() => {});
      return;
    }

    try {
      switch (action) {
        case 'approve_with_mods': {
          const changesJson = interaction.fields.getTextInputValue('changes_json');
          await interaction.deferReply().catch(() => {});
          const result = await this.orchestrator.approveReplanWithModifications(goalId, changesJson);
          if (result.success) {
            await interaction.editReply({
              content: `✅ 修改后的计划已执行\n已应用 ${result.applied} 项变更` +
                (result.rejected > 0 ? `，${result.rejected} 项被拒绝` : ''),
            }).catch(() => {});
          } else {
            await interaction.editReply({
              content: `❌ 执行失败: ${result.error}`,
            }).catch(() => {});
          }
          break;
        }

        default:
          await interaction.reply({ content: `Unknown goal modal action: ${action}`, ephemeral: true }).catch(() => {});
      }
    } catch (err: any) {
      logger.error('[DiscordBot] handleGoalModalSubmit error:', err);
      const reply = interaction.replied || interaction.deferred
        ? interaction.editReply.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `操作失败: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }

  async verify(): Promise<boolean> {
    return this.claudeClient.verify();
  }

  async launch(): Promise<void> {
    const isAvailable = await this.verify();
    if (!isAvailable) {
      throw new Error(
        'Claude Code CLI is not available.\n' +
        'Make sure Claude Code is installed and the `claude` command works.'
      );
    }
    logger.info('Claude Code CLI verified');

    await this.stateManager.load();

    // 启动消息队列
    this.messageQueue.start();

    // 初始化定价（必须在 sessionSyncService.start 之前，否则首次 syncAll 的 usage 计算无定价数据）
    await this.pricingService.init();

    // 启动 Session 同步服务（60s 增量扫描 + usage delta）
    this.sessionSyncService.start();

    // 启动每日对齐调度（01:00）
    this.usageReconciler.start();

    const guildId = this.config.authorizedGuildId;
    await registerSlashCommands(this.config.discordToken, this.config.applicationId, guildId);

    await this.client.login(this.config.discordToken);
    logger.info('Discord Bot started');

    // 全量同步 Discord Channels 到数据库
    if (this.channelService && guildId) {
      try {
        const guild = await this.client.guilds.fetch(guildId);
        await guild.channels.fetch(); // 填充缓存
        const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
        let syncCount = 0;
        for (const [, channel] of textChannels) {
          await this.channelService.syncFromDiscord(channel);
          syncCount++;
        }
        const db = getDb();
        const syncCursorRepo = new SyncCursorRepository(db);
        await syncCursorRepo.set('discord_channels', String(Date.now()));
        logger.info(`Synced ${syncCount} Discord channels to database`);
      } catch (err: any) {
        logger.error('Failed to sync Discord channels:', err);
      }
    }

    // 启动 Orchestrator
    const db = getDb();
    const goalRepo = new GoalRepo(db);
    const goalMetaRepo = new GoalMetaRepo(db);
    const taskRepo = new TaskRepo(db);
    const checkpointRepo = new CheckpointRepo(db);
    const goalTodoRepo = new GoalTodoRepository(db);
    const taskEventRepo = new TaskEventRepo(db);
    const goalTimelineRepo = new GoalTimelineRepo(db);
    const goalEventRepo = new GoalEventRepo(db);
    const orchestrator = new GoalOrchestrator({
      stateManager: this.stateManager,
      claudeClient: this.claudeClient,
      messageHandler: this.messageHandler,
      client: this.client,
      mq: this.messageQueue,
      config: this.config,
      goalRepo,
      goalMetaRepo,
      taskRepo,
      checkpointRepo,
      goalTodoRepo,
      taskEventRepo,
      goalTimelineRepo,
      goalEventRepo,
      promptService: this.promptService,
    });
    this.orchestrator = orchestrator;
    await orchestrator.restoreRunningDrives();

    // 初始化 Auth Error 拦截器
    const authErrorInterceptor = new AuthErrorInterceptor(
      // onRetry：向受影响的 channel 发送 "continue"
      (guildId, channelId) => {
        this.messageHandler.handleBackgroundChat(guildId, channelId, 'continue').catch((err: any) => {
          logger.error('[AuthErrorInterceptor] Retry "continue" failed:', err);
          // AUTH_ERROR：handleAuthError 已在 sendChatInternal 内部调用并安排了下一次重试，
          // 此处不能调 onSuccess（会重置计数并取消已安排的 timer）
          if (err instanceof ClaudeExecutionError && err.errorType === ClaudeErrorType.AUTH_ERROR) return;
          // 其他错误（如 session 已消失）：重置计数避免 Map 泄漏
          authErrorInterceptor.onSuccess(guildId, channelId);
        });
      },
      // onEmergency：pause 所有 goal，杀死所有 session，发送告警
      () => {
        logger.error('[AuthErrorInterceptor] Emergency mode activated');

        // 1. 先杀死所有活跃 Claude 进程，阻止新任务进入
        const killed = this.claudeClient.abortAll();
        logger.info(`[AuthErrorInterceptor] Killed ${killed} Claude session(s)`);

        // 2. 暂停所有运行中的 Goal（fire-and-forget，进程已终止，不依赖 Claude 进程完成）
        this.orchestrator?.pauseAllRunningDrives().catch((err: any) => {
          logger.error('[AuthErrorInterceptor] Failed to pause all goals:', err);
        });

        // 3. 发送告警到 general channel
        const generalChannelId = getGeneralChannelId();
        if (generalChannelId) {
          const timestamp = new Date().toISOString();
          this.messageQueue.send(
            generalChannelId,
            `claude auth error\n${timestamp}\nkilled ${killed} session(s), all goals paused`,
            { embedColor: EmbedColors.RED },
          ).catch(() => {});
        }
      },
    );
    this.messageHandler.setAuthErrorInterceptor(authErrorInterceptor);

    // 启动 API 服务器
    if (this.config.apiPort > 0) {
      this.apiServer = new ApiServer({
        stateManager: this.stateManager,
        claudeClient: this.claudeClient,
        messageHandler: this.messageHandler,
        client: this.client,
        mq: this.messageQueue,
        config: this.config,
        db,
        orchestrator,
        sessionSyncService: this.sessionSyncService,
        usageReconciler: this.usageReconciler,
        channelService: this.channelService ?? undefined,
        promptService: this.promptService,
      });
      await this.apiServer.start();
    }

    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  sendErrorToGeneral(
    guildId: string | undefined,
    channelId: string | undefined,
    source: string,
    error: any,
  ): void {
    const targetGuildId = guildId || getAuthorizedGuildId();
    const generalChannelId = getGeneralChannelId();
    if (!targetGuildId || !generalChannelId) return;

    const errMsg = (error?.message || String(error)).slice(0, 500);
    const channelInfo = channelId ? `Channel <#${channelId}>` : 'General';

    const doSend = async () => {
      let isUnknown = false;
      if (channelId) {
        try {
          await this.client.channels.fetch(channelId);
        } catch {
          isUnknown = true;
        }
      }

      if (isUnknown) {
        const text = `**Warning** [${escapeMarkdown(source)}]\n` +
          `Source: ${channelInfo}\n` +
          `\`\`\`\n${errMsg}\n\`\`\``;
        await this.messageQueue.send(generalChannelId, text, { embedColor: EmbedColors.YELLOW });
      } else {
        const text = `**Error** [${escapeMarkdown(source)}]\n` +
          `Source: ${channelInfo}\n` +
          `\`\`\`\n${errMsg}\n\`\`\``;
        await this.messageQueue.send(generalChannelId, text, { embedColor: EmbedColors.RED });
      }
    };

    doSend().catch((e: any) => {
      logger.debug('sendErrorToGeneral send failed:', e.message);
    });
  }

  private async stop(signal: string): Promise<void> {
    logger.info(`Received ${signal}, stopping bot...`);
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessionSyncService.stop();
    this.usageReconciler.stop();
    this.messageQueue.stop();
    await this.messageQueue.drain(10000);
    if (this.apiServer) {
      await this.apiServer.stop();
    }
    this.claudeClient.detachAll();
    await this.stateManager.flush();
    closeDb();
    this.client.destroy();
    process.exit(0);
  }
}
