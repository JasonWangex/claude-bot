/**
 * MCP 工具：DevLog + Idea 数据管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch } from '../api-client.js';

export function registerDataTools(server: McpServer) {
  // ========== DevLog ==========

  server.registerTool('bot_list_devlogs', {
    title: 'List DevLogs',
    description: 'List development logs. Supports filtering by project, single date, or date range.',
    inputSchema: {
      project: z.string().optional().describe('Filter by project name'),
      date: z.string().optional().describe('Single date filter (yyyy-MM-dd)'),
      start: z.string().optional().describe('Range start date (yyyy-MM-dd)'),
      end: z.string().optional().describe('Range end date (yyyy-MM-dd)'),
    },
  }, async ({ project, date, start, end }) => {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (date) params.set('date', date);
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    const qs = params.toString();
    const r = await apiGet(`/api/devlogs${qs ? '?' + qs : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_create_devlog', {
    title: 'Create DevLog',
    description: 'Record a development log entry to the database. Used to track merge records, feature summaries, and code changes.',
    inputSchema: {
      name: z.string().describe('Feature title (Chinese, ≤10 chars)'),
      date: z.string().describe('Date (yyyy-MM-dd)'),
      project: z.string().describe('Project name'),
      branch: z.string().optional().describe('Branch name'),
      summary: z.string().optional().describe('One-sentence summary'),
      commits: z.number().optional().describe('Number of commits'),
      lines_changed: z.string().optional().describe('Diff stat (e.g. "3 files changed, 50+, 10-")'),
      goal: z.string().optional().describe('Associated goal name'),
      content: z.string().optional().describe('Detailed Markdown content'),
    },
  }, async ({ name, date, project, branch, summary, commits, lines_changed, goal, content }) => {
    const r = await apiPost('/api/devlogs', {
      name, date, project, branch, summary, commits, lines_changed, goal, content,
    });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  // ========== Ideas ==========

  server.registerTool('bot_list_ideas', {
    title: 'List Ideas',
    description: 'List recorded ideas. Supports filtering by project and status (Idea/Processing/Done).',
    inputSchema: {
      project: z.string().optional().describe('Filter by project name'),
      status: z.string().optional().describe('Filter by status: Idea, Processing, Done'),
    },
  }, async ({ project, status }) => {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (status) params.set('status', status);
    const qs = params.toString();
    const r = await apiGet(`/api/ideas${qs ? '?' + qs : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_create_idea', {
    title: 'Create Idea',
    description: 'Record a new idea to the database with Status=Idea. Quick capture without discussion.',
    inputSchema: {
      name: z.string().describe('Idea description'),
      project: z.string().describe('Project name'),
    },
  }, async ({ name, project }) => {
    const r = await apiPost('/api/ideas', { name, project, status: 'Idea' });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_update_idea', {
    title: 'Update Idea',
    description: 'Update an idea\'s name, status, or project.',
    inputSchema: {
      idea_id: z.string().describe('Idea ID'),
      name: z.string().optional().describe('New name'),
      status: z.string().optional().describe('New status: Idea, Processing, Active, Paused, Done, Dropped'),
      project: z.string().optional().describe('New project'),
    },
  }, async ({ idea_id, ...fields }) => {
    const body = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    const r = await apiPatch(`/api/ideas/${idea_id}`, body);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
