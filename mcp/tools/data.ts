/**
 * MCP 工具：DevLog + Idea 数据管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch } from '../api-client.js';

export function registerDataTools(server: McpServer) {
  // ========== DevLog ==========

  server.registerTool('bot_devlogs', {
    title: 'DevLogs',
    description: 'DevLog: list (filter by project/date/range) or create (record dev log entry).',
    inputSchema: {
      action: z.enum(['list', 'create']).describe('Operation type'),
      project: z.string().optional().describe('Project name'),
      date: z.string().optional().describe('Date yyyy-MM-dd'),
      start: z.string().optional().describe('Range start yyyy-MM-dd (list)'),
      end: z.string().optional().describe('Range end yyyy-MM-dd (list)'),
      name: z.string().optional().describe('Feature title, Chinese ≤10 chars (create)'),
      branch: z.string().optional().describe('Branch name (create)'),
      summary: z.string().optional().describe('One-sentence summary (create)'),
      commits: z.number().optional().describe('Commit count (create)'),
      lines_changed: z.string().optional().describe('Diff stat (create)'),
      goal: z.string().optional().describe('Associated goal name (create)'),
      content: z.string().optional().describe('Detailed Markdown content (create)'),
    },
  }, async ({ action, project, date, start, end, ...fields }) => {
    switch (action) {
      case 'list': {
        const params = new URLSearchParams();
        if (project) params.set('project', project);
        if (date) params.set('date', date);
        if (start) params.set('start', start);
        if (end) params.set('end', end);
        const qs = params.toString();
        const r = await apiGet(`/api/devlogs${qs ? '?' + qs : ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'create': {
        const r = await apiPost('/api/devlogs', {
          name: fields.name, date, project,
          branch: fields.branch, summary: fields.summary,
          commits: fields.commits, lines_changed: fields.lines_changed,
          goal: fields.goal, content: fields.content,
        });
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });

  // ========== Ideas ==========

  server.registerTool('bot_ideas', {
    title: 'Ideas',
    description: 'Idea CRUD. list (project/status filter), create (name+project), update (idea_id+fields).',
    inputSchema: {
      action: z.enum(['list', 'create', 'update']).describe('Operation type'),
      idea_id: z.string().optional().describe('Idea ID (update)'),
      name: z.string().optional().describe('Idea description (create/update)'),
      project: z.string().optional().describe('Project name'),
      status: z.string().optional().describe('Idea/Processing/Active/Paused/Done/Dropped'),
    },
  }, async ({ action, idea_id, ...fields }) => {
    switch (action) {
      case 'list': {
        const params = new URLSearchParams();
        if (fields.project) params.set('project', fields.project);
        if (fields.status) params.set('status', fields.status);
        const qs = params.toString();
        const r = await apiGet(`/api/ideas${qs ? '?' + qs : ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'create': {
        const r = await apiPost('/api/ideas', {
          name: fields.name, project: fields.project, status: 'Idea',
        });
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'update': {
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        const r = await apiPatch(`/api/ideas/${idea_id}`, body);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
