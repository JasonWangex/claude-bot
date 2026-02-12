/**
 * Model 命令: /model
 * 在 General 中切换全局默认模型，在 task channel 中切换当前 channel 模型
 * 使用 Discord StringSelectMenu 替代 Telegram Inline Keyboard
 */

import {
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { MODEL_OPTIONS, getModelLabel } from './task.js';
import type { CommandDeps } from './types.js';
import { requireAuth } from './utils.js';

export const modelCommands = [
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch Claude model (global default or current thread)'),
];

export async function handleModelCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!requireAuth(interaction)) return;

  const guildId = interaction.guildId!;
  const { stateManager } = deps;
  const channelId = interaction.channelId;
  const hasSession = !!stateManager.getSession(guildId, channelId);

  if (!hasSession) {
    // General: 设置全局默认模型
    const currentModel = stateManager.getGuildDefaultModel(guildId);
    const currentLabel = getModelLabel(currentModel);

    const select = new StringSelectMenuBuilder()
      .setCustomId('gmodel_select')
      .setPlaceholder('Select global default model')
      .addOptions(
        ...MODEL_OPTIONS.map(opt =>
          new StringSelectMenuOptionBuilder()
            .setLabel(opt.label)
            .setValue(opt.id)
            .setDefault(currentModel === opt.id)
        ),
        new StringSelectMenuOptionBuilder()
          .setLabel('Sonnet 4.5 (default)')
          .setValue('default')
          .setDefault(!currentModel),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.reply({
      content: `**Current global model:** ${currentLabel}\n\nNew threads will use this model. Select to change:`,
      components: [row],
    });
  } else {
    // Channel: 设置当前 channel 模型
    const threadId = channelId;
    const channelName = (interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null) ?? `channel-${threadId}`;
    const session = stateManager.getOrCreateSession(guildId, threadId, {
      name: channelName,
      cwd: stateManager.getGuildDefaultCwd(guildId),
    });
    const guildModel = stateManager.getGuildDefaultModel(guildId);
    const currentLabel = session.model !== undefined
      ? getModelLabel(session.model)
      : `${getModelLabel(guildModel)} (follow default)`;

    const select = new StringSelectMenuBuilder()
      .setCustomId('model_select')
      .setPlaceholder('Select model for this thread')
      .addOptions(
        ...MODEL_OPTIONS.map(opt =>
          new StringSelectMenuOptionBuilder()
            .setLabel(opt.label)
            .setValue(opt.id)
            .setDefault(session.model === opt.id)
        ),
        new StringSelectMenuOptionBuilder()
          .setLabel('Follow default')
          .setValue('follow_default')
          .setDefault(session.model === undefined),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.reply({
      content: `**Current model:** ${currentLabel}\n\nSelect to change:`,
      components: [row],
    });
  }
}
