/**
 * Discord Slash Commands 注册与路由
 */

import {
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { generalCommands, handleGeneralCommand } from './general.js';
import { taskCommands, handleTaskCommand } from './task.js';
import { sessionCommands, handleSessionCommand } from './session.js';
import { modelCommands, handleModelCommand } from './model.js';
import { devCommands, handleDevCommand } from './dev.js';
import { goalCommands, handleGoalCommand } from './goal.js';
import type { CommandDeps } from './types.js';

// 所有命令定义
const allCommands: (SlashCommandBuilder | SlashCommandOptionsOnlyBuilder)[] = [
  ...generalCommands,
  ...taskCommands,
  ...sessionCommands,
  ...modelCommands,
  ...devCommands,
  ...goalCommands,
];

/**
 * 向 Discord API 注册所有 Slash Commands
 */
export async function registerSlashCommands(token: string, applicationId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const commandData = allCommands.map(cmd => cmd.toJSON());

  if (guildId) {
    // Guild-specific（开发环境，立即生效）
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commandData });
    logger.info(`Registered ${commandData.length} guild commands for ${guildId}`);
  } else {
    // Global（生产环境，最多 1 小时生效）
    await rest.put(Routes.applicationCommands(applicationId), { body: commandData });
    logger.info(`Registered ${commandData.length} global commands`);
  }
}

const GENERAL_CMDS = new Set(['login', 'start', 'help', 'status']);
const TASK_CMDS = new Set(['task', 'close', 'info', 'cd']);
const SESSION_CMDS = new Set(['clear', 'compact', 'rewind', 'plan', 'stop', 'attach']);
const MODEL_CMDS = new Set(['model']);
const DEV_CMDS = new Set(['qdev', 'idea', 'commit', 'merge']);
const GOAL_CMDS = new Set(['goal']);

/**
 * 路由 Slash Command 到对应处理器
 */
export async function routeCommand(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  const { commandName } = interaction;

  if (GENERAL_CMDS.has(commandName)) {
    await handleGeneralCommand(interaction, deps);
    return;
  }

  if (TASK_CMDS.has(commandName)) {
    await handleTaskCommand(interaction, deps);
    return;
  }

  if (SESSION_CMDS.has(commandName)) {
    await handleSessionCommand(interaction, deps);
    return;
  }

  if (MODEL_CMDS.has(commandName)) {
    await handleModelCommand(interaction, deps);
    return;
  }

  if (DEV_CMDS.has(commandName)) {
    await handleDevCommand(interaction, deps);
    return;
  }

  if (GOAL_CMDS.has(commandName)) {
    await handleGoalCommand(interaction, deps);
    return;
  }

  await interaction.reply({ content: `Unknown command: /${commandName}`, ephemeral: true });
}

export { allCommands };
