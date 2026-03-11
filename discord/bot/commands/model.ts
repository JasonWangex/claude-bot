/**
 * Model 命令: /model
 * 在 General 中切换全局默认模型，在 task channel 中切换当前 channel 模型 + effort
 * 使用 Discord StringSelectMenu
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

const EFFORT_OPTIONS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
];

export const modelCommands = [
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch Claude model and effort (global default or current thread)'),
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
          .setLabel(`${getModelLabel(process.env.PIPELINE_SONNET_MODEL || 'claude-sonnet-4-6')} (default)`)
          .setValue('default')
          .setDefault(!currentModel),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.reply({
      content: `**Current global model:** ${currentLabel}\n\nNew threads will use this model. Select to change:`,
      components: [row],
    });
  } else {
    // Channel: 设置当前 channel 模型 + effort
    const channelName = (interaction.channel && 'name' in interaction.channel ? interaction.channel.name : null) ?? `channel-${channelId}`;
    const session = stateManager.getOrCreateSession(guildId, channelId, {
      name: channelName,
      cwd: stateManager.getGuildDefaultCwd(guildId),
    });
    const guildModel = stateManager.getGuildDefaultModel(guildId);
    const currentModelLabel = session.model !== undefined
      ? getModelLabel(session.model)
      : `${getModelLabel(guildModel)} (follow default)`;
    const currentEffortLabel = session.effort ?? 'default';

    const modelSelect = new StringSelectMenuBuilder()
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

    const effortSelect = new StringSelectMenuBuilder()
      .setCustomId('effort_select')
      .setPlaceholder('Select effort level')
      .addOptions(
        ...EFFORT_OPTIONS.map(opt =>
          new StringSelectMenuOptionBuilder()
            .setLabel(opt.label)
            .setValue(opt.id)
            .setDefault(session.effort === opt.id)
        ),
        new StringSelectMenuOptionBuilder()
          .setLabel('Default')
          .setValue('effort_default')
          .setDefault(session.effort === undefined),
      );

    const modelRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect);
    const effortRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortSelect);

    await interaction.reply({
      content: `**Model:** ${currentModelLabel} | **Effort:** ${currentEffortLabel}`,
      components: [modelRow, effortRow],
    });
  }
}
