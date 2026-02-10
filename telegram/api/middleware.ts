/**
 * API 中间件：JSON body 解析 + 通用响应工具
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getAuthorizedChatId } from '../utils/env.js';

/**
 * 读取请求体并解析为 JSON
 */
export async function readJsonBody<T = any>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) { resolve(null); return; }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 发送 JSON 响应
 */
export function sendJson(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * 要求 Bot 已授权，返回 groupId；未授权时自动回复 503
 */
export function requireAuth(res: ServerResponse): number | null {
  const chatId = getAuthorizedChatId();
  if (!chatId) {
    sendJson(res, 503, {
      ok: false,
      error: 'Bot not yet authorized. Use /login in Telegram first.',
    });
    return null;
  }
  return chatId;
}
