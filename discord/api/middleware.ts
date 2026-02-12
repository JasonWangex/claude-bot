/**
 * API 中间件：JSON body 解析 + 通用响应工具（Discord 版）
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getAuthorizedGuildId } from '../utils/env.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * 读取请求体并解析为 JSON（限制 1MB）
 */
export async function readJsonBody<T = any>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) { resolve(null); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
 * 验证 API 请求的 Bearer token
 */
export function requireToken(req: IncomingMessage, res: ServerResponse, accessToken: string): boolean {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${accessToken}`) {
    sendJson(res, 401, { ok: false, error: 'Invalid or missing Authorization header' });
    return false;
  }
  return true;
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
