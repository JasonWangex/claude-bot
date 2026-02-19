/**
 * MCP 工具：Goal 管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch } from '../api-client.js';

/** Drive task 结构（传入 JSON 字符串，内部解析） */
interface DriveTask {
  id: string;
  description: string;
  type?: string;
  depends?: string[];
  phase?: number;
  complexity?: string;
}

export function registerGoalTools(server: McpServer) {
  server.registerTool('bot_goals', {
    title: 'Goals',
    description: 'Goal management. action: list, get, create, update, drive.',
    inputSchema: {
      action: z.enum(['list', 'get', 'create', 'update', 'drive']).describe('Operation type'),
      goal_id: z.string().optional().describe('Goal ID (get/update/drive)'),
      name: z.string().optional().describe('Goal name (create/update)'),
      project: z.string().optional().describe('Project name'),
      status: z.string().optional().describe('Pending/Collecting/Planned/Processing/Blocking/Completed/Merged'),
      q: z.string().optional().describe('Search keyword (list)'),
      type: z.string().optional().describe('探索型 or 交付型'),
      completion: z.string().optional().describe('Completion criteria'),
      body: z.string().optional().describe('Body content (Markdown)'),
      progress: z.string().optional().describe('Progress note (update)'),
      next: z.string().optional().describe('Next step (update)'),
      blocked_by: z.string().optional().describe('Blocker description (update)'),
      // drive params
      goal_name: z.string().optional().describe('Goal display name (drive)'),
      goal_channel_id: z.string().optional().describe('Discord channel ID for goal thread (drive)'),
      base_cwd: z.string().optional().describe('Base working directory (drive)'),
      tasks: z.string().optional().describe('JSON array of tasks (drive)'),
      max_concurrent: z.number().optional().describe('Max concurrent sub-tasks, default 3 (drive)'),
    },
  }, async ({ action, goal_id, q, ...fields }) => {
    switch (action) {
      case 'list': {
        const params = new URLSearchParams();
        if (fields.status) params.set('status', fields.status);
        if (fields.project) params.set('project', fields.project);
        if (q) params.set('q', q);
        const qs = params.toString();
        const r = await apiGet(`/api/goals${qs ? '?' + qs : ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'get': {
        const r = await apiGet(`/api/goals/${goal_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'create': {
        const r = await apiPost('/api/goals', {
          name: fields.name, project: fields.project, status: fields.status,
          type: fields.type, completion: fields.completion, body: fields.body,
        });
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'update': {
        const { goal_name, goal_channel_id, base_cwd, tasks, max_concurrent, ...updateFields } = fields;
        const body = Object.fromEntries(
          Object.entries(updateFields).filter(([, v]) => v !== undefined)
        );
        const r = await apiPatch(`/api/goals/${goal_id}`, body);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'drive': {
        let parsedTasks: DriveTask[];
        try {
          parsedTasks = JSON.parse(fields.tasks || '[]');
        } catch {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Invalid tasks JSON' }) }] };
        }
        const r = await apiPost(`/api/goals/${goal_id}/drive`, {
          goalName: fields.goal_name,
          goalChannelId: fields.goal_channel_id,
          baseCwd: fields.base_cwd,
          tasks: parsedTasks,
          maxConcurrent: fields.max_concurrent,
        });
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
