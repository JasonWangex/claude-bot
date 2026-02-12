/**
 * Slash Command 共用工具函数
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import { checkAuth } from '../auth.js';
import { getAuthorizedGuildId } from '../../utils/env.js';

export function requireAuth(interaction: ChatInputCommandInteraction): boolean {
  if (!checkAuth(interaction.guildId)) {
    const authorizedGuildId = getAuthorizedGuildId();
    interaction.reply({
      content: authorizedGuildId
        ? 'Unauthorized. This bot is bound to another server.'
        : 'Please use `/login <token>` first.',
      ephemeral: true,
    }).catch(() => {});
    return false;
  }
  return true;
}

export function requireThread(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.channel?.isThread()) {
    interaction.reply({
      content: 'This command must be used inside a Forum Post thread.',
      ephemeral: true,
    }).catch(() => {});
    return false;
  }
  return true;
}
