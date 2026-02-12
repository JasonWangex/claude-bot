/**
 * API 中间件：JSON body 解析 + 通用响应工具（Discord 版）
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getAuthorizedGuildId } from '../utils/env.js';

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
 * 要求 Bot 已授权，返回 guildId；未授权时自动回复 401
 */
export function requireAuth(res: ServerResponse): string | null {
  const guildId = getAuthorizedGuildId();
  if (!guildId) {
    sendJson(res, 401, {
      ok: false,
      error: 'Bot not yet authorized. Use /login in Discord first.',
    });
    return null;
  }
  return guildId;
}
