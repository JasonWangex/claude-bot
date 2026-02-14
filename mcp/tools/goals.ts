/**
 * MCP 工具：Goal 管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch } from '../api-client.js';

export function registerGoalTools(server: McpServer) {
  server.registerTool('bot_list_goals', {
    title: 'List Goals',
    description: 'List development goals. Supports filtering by status (Pending/Collecting/Planned/Processing/Blocking/Completed/Merged), project name, and keyword search.',
    inputSchema: {
      status: z.string().optional().describe('Filter by status: Pending, Collecting, Planned, Processing, Blocking, Completed, Merged'),
      project: z.string().optional().describe('Filter by project name'),
      q: z.string().optional().describe('Search keyword'),
    },
  }, async ({ status, project, q }) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (project) params.set('project', project);
    if (q) params.set('q', q);
    const qs = params.toString();
    const r = await apiGet(`/api/goals${qs ? '?' + qs : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_get_goal', {
    title: 'Get Goal Detail',
    description: 'Get detailed information about a goal, including sub-tasks, dependencies, progress, and drive status.',
    inputSchema: {
      goal_id: z.string().describe('Goal ID'),
    },
  }, async ({ goal_id }) => {
    const r = await apiGet(`/api/goals/${goal_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_create_goal', {
    title: 'Create Goal',
    description: 'Create a new development goal with optional sub-task breakdown in the body field (Markdown format).',
    inputSchema: {
      name: z.string().describe('Goal name'),
      project: z.string().describe('Project name'),
      status: z.string().optional().describe('Status: Pending (default), Collecting, Planned, Processing, Blocking, Completed, Merged'),
      type: z.string().optional().describe('Type: 探索型 or 交付型'),
      completion: z.string().optional().describe('Completion criteria'),
      body: z.string().optional().describe('Detailed content with sub-task breakdown (Markdown)'),
    },
  }, async ({ name, project, status, type, completion, body }) => {
    const r = await apiPost('/api/goals', {
      name, project, status, type, completion, body,
    });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_update_goal', {
    title: 'Update Goal',
    description: 'Update a goal\'s metadata, progress, or body content.',
    inputSchema: {
      goal_id: z.string().describe('Goal ID'),
      name: z.string().optional().describe('New name'),
      status: z.string().optional().describe('New status: Pending, Collecting, Planned, Processing, Blocking, Completed, Merged'),
      type: z.string().optional().describe('New type'),
      project: z.string().optional().describe('New project'),
      completion: z.string().optional().describe('New completion criteria'),
      progress: z.string().optional().describe('Current progress note'),
      next: z.string().optional().describe('Next step'),
      blocked_by: z.string().optional().describe('Blocker description'),
      body: z.string().optional().describe('Updated body content (Markdown)'),
    },
  }, async ({ goal_id, ...fields }) => {
    // Remove undefined values
    const body = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    const r = await apiPatch(`/api/goals/${goal_id}`, body);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
