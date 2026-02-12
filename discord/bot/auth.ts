/**
 * Discord Bot 鉴权：检查消息是否来自已授权的 Guild
 */

import { getAuthorizedGuildId } from '../utils/env.js';

export function checkAuth(guildId: string | null | undefined): boolean {
  if (!guildId) return false;
  const authorizedGuildId = getAuthorizedGuildId();
  if (!authorizedGuildId) return false;
  return guildId === authorizedGuildId;
}
