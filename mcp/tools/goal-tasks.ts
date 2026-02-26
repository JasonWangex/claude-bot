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
    description: 'Goal sub-task management. action: list (tasks in a drive), set (bulk-write initial tasks before drive), skip, done, retry (light resume in existing channel — covers failed/blocked_feedback/paused), reset (full reset, start fresh), pause, nudge (light-push to let agent self-assess and continue).',
    inputSchema: {
      action: z.enum(['list', 'set', 'skip', 'done', 'retry', 'reset', 'pause', 'nudge']).describe('Operation type'),
      goal_id: z.string().describe('Goal ID'),
      task_id: z.string().optional().describe('Task ID (required for skip/done/retry/reset/pause/nudge)'),
      tasks: z.string().optional().describe('JSON array of tasks (required for set). Each: {id, description, type, phase, complexity}'),
    },
  }, async ({ action, goal_id, task_id, tasks }) => {
    switch (action) {
      case 'list': {
        const r = await apiGet(`/api/goals/${goal_id}/status`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'set': {
        let parsed: unknown[];
        try { parsed = JSON.parse(tasks || '[]'); } catch {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Invalid tasks JSON' }) }] };
        }
        const r = await apiPost(`/api/goals/${goal_id}/tasks`, { tasks: parsed });
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
      case 'reset': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/reset`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'pause': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/pause`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'nudge': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/nudge`, {});
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
