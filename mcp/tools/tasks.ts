/**
 * MCP 工具：Task 管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiDelete } from '../api-client.js';

export function registerTaskTools(server: McpServer) {
  server.registerTool('bot_tasks', {
    title: 'Tasks',
    description: 'Task management. action: list (all tasks), get (by task_id), delete (by task_id, cascade optional).',
    inputSchema: {
      action: z.enum(['list', 'get', 'delete']).default('list').describe('Operation type'),
      task_id: z.string().optional().describe('Task ID (get/delete)'),
      cascade: z.boolean().optional().describe('Delete child tasks too (delete)'),
    },
  }, async ({ action, task_id, cascade }) => {
    switch (action) {
      case 'list': {
        const r = await apiGet('/api/tasks');
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'get': {
        const r = await apiGet(`/api/tasks/${task_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'delete': {
        const qs = cascade ? '?cascade=true' : '';
        const r = await apiDelete(`/api/tasks/${task_id}${qs}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });

  server.registerTool('bot_send_message', {
    title: 'Send Message',
    description: 'Send message to a task thread, triggering Claude to process it.',
    inputSchema: {
      task_id: z.string().describe('Task ID'),
      text: z.string().describe('Message text'),
    },
  }, async ({ task_id, text }) => {
    const r = await apiPost(`/api/tasks/${task_id}/message`, { text });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_qdev', {
    title: 'Quick Dev',
    description: 'Quick-create dev sub-task: auto branch, worktree, Discord channel, trigger Claude.',
    inputSchema: {
      task_id: z.string().describe('Task ID to create sub-task from'),
      description: z.string().describe('Task description'),
    },
  }, async ({ task_id, description }) => {
    const r = await apiPost(`/api/tasks/${task_id}/qdev`, { description });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
