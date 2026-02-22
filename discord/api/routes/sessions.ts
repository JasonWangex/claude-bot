/**
 * Session Conversation API
 *
 * GET /api/sessions/:id/conversation — 流式读取 Claude session 的完整对话历史
 *
 * 不再从内存 messageHistory 读取，改为从 ~/.claude/projects/xxx/*.jsonl 文件流式读取
 */

import { join } from 'path';
import type { RouteHandler } from '../types.js';
import { requireAuth } from '../middleware.js';
import { findSessionJsonlFile, streamSessionEvents } from '../../utils/session-reader.js';
import { logger } from '../../utils/logger.js';

/**
 * GET /api/sessions/:id/conversation
 *
 * 返回指定 Claude session 的完整对话历史（流式 JSONL 格式）
 *
 * Response:
 * - Content-Type: application/x-ndjson (JSONL)
 * - 每行一个 JSON 对象，对应一个 Claude CLI 事件
 *
 * Error cases:
 * - 404: Session not found
 * - 404: JSONL file not found
 * - 500: Read error
 */
export const getSessionConversation: RouteHandler = async (_req, res, params, deps) => {
  const guildId = requireAuth(res);
  if (!guildId) return;

  const sessionId = params.id;
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Session ID required' }));
    return;
  }

  try {
    // 查询 claude_sessions 表
    // sessionId 就是 CLI session ID（PK）
    const claudeProjectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
    const jsonlPath = findSessionJsonlFile(claudeProjectsDir, sessionId);

    if (!jsonlPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Session JSONL file not found' }));
      return;
    }

    // 设置流式响应头
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    // 流式读取并返回事件
    streamSessionEvents(
      jsonlPath,
      (event) => {
        // 每个事件写入一行 JSON
        res.write(JSON.stringify(event) + '\n');
      },
      () => {
        // 读取完成
        res.end();
        logger.info(`Session conversation streamed: ${sessionId.slice(0, 8)}...`);
      },
      (error) => {
        // 读取错误（可能已经发送了部分数据，无法返回 500）
        logger.error('Failed to stream session conversation:', error);
        res.end();
      },
    );
  } catch (error: any) {
    logger.error('Error in getSessionConversation:', error);
    // 如果还没发送响应头，可以返回 500
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Internal error: ${error.message}` }));
    } else {
      res.end();
    }
  }
};
