/**
 * MCP 工具：Goal 子任务管理
 *
 * 操作 Goal Drive 编排中的子任务（tasks 表），
 * 与 bot_channels 操作的 Discord 频道不同。
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost } from '../api-client.js';

export function registerGoalTaskTools(server: McpServer) {
  server.registerTool('bot_goal_tasks', {
    title: 'Goal Tasks',
    description: 'Goal sub-task management. action: list (tasks in a drive), skip, done, retry, refix, pause, resume.',
    inputSchema: {
      action: z.enum(['list', 'skip', 'done', 'retry', 'refix', 'pause', 'resume']).describe('Operation type'),
      goal_id: z.string().describe('Goal ID'),
      task_id: z.string().optional().describe('Task ID (required for skip/done/retry/refix/pause/resume)'),
    },
  }, async ({ action, goal_id, task_id }) => {
    switch (action) {
      case 'list': {
        const r = await apiGet(`/api/goals/${goal_id}/status`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'skip': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/skip`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'done': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/done`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'retry': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/retry`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'refix': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/refix`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'pause': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/pause`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'resume': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/resume`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
