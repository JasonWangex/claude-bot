/**
 * Command 处理器共用的依赖注入接口
 */

import type { Client } from 'discord.js';
import type { StateManager } from '../state.js';
import type { ClaudeClient } from '../../claude/client.js';
import type { MessageHandler } from '../handlers.js';
import type { MessageQueue } from '../message-queue.js';
import type { DiscordBotConfig } from '../../types/index.js';
import type { ChannelService } from '../../services/channel-service.js';
import type { PromptConfigService } from '../../services/prompt-config-service.js';

export interface CommandDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  client: Client;
  config: DiscordBotConfig;
  messageHandler: MessageHandler;
  messageQueue: MessageQueue;
  channelService?: ChannelService;
  promptService: PromptConfigService;
}
