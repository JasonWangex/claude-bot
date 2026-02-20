/**
 * MCP 工具：Task 事件写入
 *
 * AI session（task / brain）通过此工具写入结构化事件，
 * 替换原有的写 JSON 文件 + git commit 方式。
 * Orchestrator 自动检测并处理事件。
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPost } from '../api-client.js';

export function registerTaskEventTools(server: McpServer) {
  server.registerTool('bot_task_event', {
    title: 'Task Event',
    description:
      'Write a structured event to the database. ' +
      'Use this instead of writing JSON files to disk. ' +
      'The orchestrator will automatically detect and process your event.',
    inputSchema: {
      task_id: z.string().describe('The task ID provided in your prompt (TASK_ID variable)'),
      event_type: z
        .enum([
          'feedback.main',
          'feedback.audit',
          'feedback.self_review',
          'feedback.investigate',
          'feedback.readiness',
          'brain.eval',
          'brain.failure',
          'brain.replan',
        ])
        .describe('Event type — determines how the orchestrator processes this event'),
      payload: z
        .record(z.unknown())
        .describe('Event payload. Structure varies by event_type (see prompt instructions).'),
    },
  }, async ({ task_id, event_type, payload }) => {
    const r = await apiPost(`/api/tasks/${task_id}/events`, { event_type, payload });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(r.data ?? r, null, 2),
        },
      ],
    };
  });
}
