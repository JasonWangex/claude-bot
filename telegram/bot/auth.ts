/**
 * Telegram Bot 公共鉴权逻辑
 */

import { Context } from 'telegraf';
import { StateManager } from './state.js';
import { getAuthorizedChatId } from '../utils/env.js';

export function checkAuth(ctx: Context, stateManager: StateManager): boolean {
  if (!ctx.from || !ctx.chat) return false;
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  const authorizedChatId = getAuthorizedChatId();

  if (authorizedChatId) {
    if (chatId === authorizedChatId) {
      stateManager.setAuthorized(userId, true);
      return true;
    }
    return false;
  }

  return stateManager.isAuthorized(userId);
}
