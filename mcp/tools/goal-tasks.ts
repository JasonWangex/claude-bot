/**
 * MCP 工具：Goal 子任务管理
 *
 * 操作 Goal Drive 编排中的子任务（tasks 表），
 * 与 bot_channels 操作的 Discord 频道不同。
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerGoalTaskTools(server: McpServer) {
  server.registerTool('bot_goal_tasks', {
    title: 'Goal Tasks',
    description: [
      'Goal sub-task management. Actions:',
      '  list — view all tasks in a drive',
      '  set — bulk-write initial tasks before drive',
      '  add — add a single task (id, description required; type, phase, complexity optional)',
      '  update — modify task fields (description, type, phase, complexity)',
      '  remove — cancel a task (sets status=cancelled)',
      '  skip — skip task',
      '  done — mark task completed',
      '  retry — light resume in existing channel',
      '  reset — full reset, start fresh',
      '  pause — soft pause (session continues, but won\'t advance)',
      '  stop — hard stop (kill session, mark failed)',
      '  nudge — light-push to let agent self-assess and continue',
    ].join('\n'),
    inputSchema: {
      action: z.enum(['list', 'set', 'add', 'update', 'remove', 'skip', 'done', 'retry', 'reset', 'pause', 'stop', 'nudge']).describe('Operation type'),
      goal_id: z.string().describe('Goal ID'),
      task_id: z.string().optional().describe('Task ID (required for most actions except list/set)'),
      tasks: z.string().optional().describe('JSON array of tasks (required for set). Each: {id, description, type, phase, complexity}'),
      description: z.string().optional().describe('Task description (for add/update)'),
      type: z.string().optional().describe('Task type: 代码/手动/调研/占位/测试 (for add/update)'),
      phase: z.number().optional().describe('Task phase number (for add/update)'),
      complexity: z.string().optional().describe('Task complexity: simple/complex (for add/update)'),
    },
  }, async ({ action, goal_id, task_id, tasks, description, type, phase, complexity }) => {
    switch (action) {
      case 'list': {
        const r = await apiGet(`/api/goals/${goal_id}/status`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'set': {
        let parsed: unknown[];
        try { parsed = JSON.parse(tasks || '[]'); } catch {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Invalid tasks JSON' }) }] };
        }
        const r = await apiPost(`/api/goals/${goal_id}/tasks`, { tasks: parsed });
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'add': {
        if (!task_id || !description) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Required: task_id, description' }) }] };
        }
        const body: Record<string, unknown> = { id: task_id, description };
        if (type) body.type = type;
        if (phase !== undefined) body.phase = phase;
        if (complexity) body.complexity = complexity;
        const r = await apiPost(`/api/goals/${goal_id}/tasks/add`, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'update': {
        if (!task_id) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Required: task_id' }) }] };
        }
        const body: Record<string, unknown> = {};
        if (description !== undefined) body.description = description;
        if (type !== undefined) body.type = type;
        if (phase !== undefined) body.phase = phase;
        if (complexity !== undefined) body.complexity = complexity;
        const r = await apiPatch(`/api/goals/${goal_id}/tasks/${task_id}`, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'remove': {
        if (!task_id) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Required: task_id' }) }] };
        }
        const r = await apiDelete(`/api/goals/${goal_id}/tasks/${task_id}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'stop': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/stop`, {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'skip':
      case 'done':
      case 'retry':
      case 'reset':
      case 'pause':
      case 'nudge': {
        const r = await apiPost(`/api/goals/${goal_id}/tasks/${task_id}/${action}`, {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
