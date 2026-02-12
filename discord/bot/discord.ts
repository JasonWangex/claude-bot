/**
 * Discord Bot 初始化（Guild + Category/Channels 模式）
 */

import {
  Client,
  GatewayIntentBits,
  Events,
} from 'discord.js';
import { StateManager } from './state.js';
import { InteractionRegistry } from './interaction-registry.js';
import { MessageQueue, EmbedColors } from './message-queue.js';
import { MessageHandler } from './handlers.js';
import { ClaudeClient } from '../claude/client.js';
import { DiscordBotConfig } from '../types/index.js';
import { checkAuth } from './auth.js';
import { logger } from '../utils/logger.js';
import { ApiServer } from '../api/server.js';
import { GoalOrchestrator } from '../orchestrator/index.js';
import { initDb, getDb, closeDb } from '../db/index.js';
import { GoalRepo } from '../db/repo/index.js';
import { SessionRepository } from '../db/repo/session-repo.js';
import { GuildRepository } from '../db/repo/guild-repo.js';
import { getAuthorizedGuildId, getGeneralChannelId } from '../utils/env.js';
import { escapeMarkdown } from './message-utils.js';
import { registerSlashCommands, routeCommand } from './commands/index.js';
import { MODEL_OPTIONS, getModelLabel } from './commands/task.js';
import type { CommandDeps } from './commands/types.js';

export class DiscordBot {
  private client: Client;
  private stateManager: StateManager;
  private interactionRegistry: InteractionRegistry;
  private messageQueue: MessageQueue;
  private messageHandler: MessageHandler;
  private claudeClient: ClaudeClient;
  private config: DiscordBotConfig;
  private apiServer: ApiServer | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: DiscordBotConfig) {
    this.config = config;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    const db = initDb();
    const sessionRepo = new SessionRepository(db);
    const guildRepo = new GuildRepository(db);
    this.stateManager = new StateManager(config.defaultWorkDir, sessionRepo, guildRepo);
    this.interactionRegistry = new InteractionRegistry();
    this.claudeClient = new ClaudeClient(
      config.claudeCliPath,
      config.commandTimeout,
      config.maxTurns,
      config.stallTimeout,
    );
    this.messageQueue = new MessageQueue(this.client);
    this.messageHandler = new MessageHandler(this.stateManager, this.claudeClient, this.interactionRegistry, this.messageQueue);
    this.messageHandler.setErrorReporter((guildId, threadId, source, error) => this.sendErrorToGeneral(guildId, threadId, source, error));

    this.registerHandlers();

    // 定期清理
    this.cleanupInterval = setInterval(() => {
      this.stateManager.cleanup();
      this.interactionRegistry.cleanup();
    }, 60 * 60 * 1000);
  }

  private getCommandDeps(): CommandDeps {
    return {
      stateManager: this.stateManager,
      claudeClient: this.claudeClient,
      client: this.client,
      config: this.config,
      messageHandler: this.messageHandler,
      messageQueue: this.messageQueue,
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
        this.interactionRegistry.resolve(waitingEntry.toolUseId, message.content);
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
      const threadId = interaction.channelId;
      const model = selected === 'follow_default' ? undefined : selected;
      this.stateManager.setSessionModel(guildId, threadId, model);
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

  private async handleModalSubmit(interaction: any): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId || !checkAuth(guildId)) return;

    const customId = interaction.customId;

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

    const guildId = this.config.authorizedGuildId;
    await registerSlashCommands(this.config.discordToken, this.config.applicationId, guildId);

    await this.client.login(this.config.discordToken);
    logger.info('Discord Bot started');

    // 启动 Orchestrator
    const goalRepo = new GoalRepo(getDb());
    const orchestrator = new GoalOrchestrator({
      stateManager: this.stateManager,
      claudeClient: this.claudeClient,
      messageHandler: this.messageHandler,
      client: this.client,
      mq: this.messageQueue,
      config: this.config,
      goalRepo,
    });
    await orchestrator.restoreRunningDrives();

    // 启动 API 服务器
    if (this.config.apiPort > 0) {
      this.apiServer = new ApiServer({
        stateManager: this.stateManager,
        claudeClient: this.claudeClient,
        messageHandler: this.messageHandler,
        client: this.client,
        mq: this.messageQueue,
        config: this.config,
        orchestrator,
      });
      await this.apiServer.start();
    }

    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  sendErrorToGeneral(
    guildId: string | undefined,
    threadId: string | undefined,
    source: string,
    error: any,
  ): void {
    const targetGuildId = guildId || getAuthorizedGuildId();
    const generalChannelId = getGeneralChannelId();
    if (!targetGuildId || !generalChannelId) return;

    const threadInfo = threadId ? `Thread <#${threadId}>` : 'General';
    const errMsg = (error?.message || String(error)).slice(0, 500);
    const text = `**Error** [${escapeMarkdown(source)}]\n` +
      `Source: ${threadInfo}\n` +
      `\`\`\`\n${errMsg}\n\`\`\``;

    this.messageQueue.send(generalChannelId, text, { embedColor: EmbedColors.RED }).catch((e: any) => {
      logger.debug('sendErrorToGeneral send failed:', e.message);
    });
  }

  private async stop(signal: string): Promise<void> {
    logger.info(`Received ${signal}, stopping bot...`);
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
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
