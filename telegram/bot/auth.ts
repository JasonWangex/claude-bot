/**
 * Telegram Bot 鉴权：检查消息是否来自已授权的 Group
 */

import { Context } from 'telegraf';
import { getAuthorizedChatId } from '../utils/env.js';

export function checkAuth(ctx: Context): boolean {
  if (!ctx.chat) return false;
  const authorizedGroupId = getAuthorizedChatId();
  if (!authorizedGroupId) return false;
  return ctx.chat.id === authorizedGroupId;
}
