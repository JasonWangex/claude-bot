/**
 * MCP 工具：Goal 待办事项管理
 *
 * 用于在 Goal 工作过程中记录临时发现的问题和提醒，
 * 与 bot_goal_tasks（结构化交付任务）互补。
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerGoalTodoTools(server: McpServer) {
  server.registerTool('bot_goal_todos', {
    title: 'Goal Todos',
    description: 'Goal todo management. action: list, add, done, undone, delete. For ad-hoc notes/reminders during goal work.',
    inputSchema: {
      action: z.enum(['list', 'add', 'done', 'undone', 'delete']).describe('Operation type'),
      goal_id: z.string().describe('Goal ID'),
      todo_id: z.string().optional().describe('Todo ID (required for done/undone/delete)'),
      content: z.string().optional().describe('Todo content (required for add)'),
      source: z.string().optional().describe('Creator source, e.g. "user", "brain" (add)'),
      priority: z.enum(['重要', '高', '中', '低']).optional().describe('Priority level (add/update). Default: 中'),
    },
  }, async ({ action, goal_id, todo_id, content, source, priority }) => {
    switch (action) {
      case 'list': {
        const r = await apiGet(`/api/goals/${goal_id}/todos`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'add': {
        const r = await apiPost(`/api/goals/${goal_id}/todos`, { content, source, priority });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'done': {
        const r = await apiPatch(`/api/goals/${goal_id}/todos/${todo_id}`, { done: true, ...(priority && { priority }) });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'undone': {
        const r = await apiPatch(`/api/goals/${goal_id}/todos/${todo_id}`, { done: false, ...(priority && { priority }) });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'delete': {
        const r = await apiDelete(`/api/goals/${goal_id}/todos/${todo_id}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
