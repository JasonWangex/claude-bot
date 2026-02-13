/**
 * MCP 工具：Knowledge Base 知识库管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerKnowledgeBaseTools(server: McpServer) {
  server.registerTool('bot_list_kb', {
    title: 'List Knowledge Base',
    description: 'List knowledge base entries. Supports filtering by project, category, or search query.',
    inputSchema: {
      project: z.string().optional().describe('Filter by project name'),
      category: z.string().optional().describe('Filter by category (e.g. Architecture, Troubleshooting, API, Design)'),
      q: z.string().optional().describe('Search query (matches title or content)'),
    },
  }, async ({ project, category, q }) => {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    const qs = params.toString();
    const r = await apiGet(`/api/kb${qs ? '?' + qs : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_get_kb', {
    title: 'Get Knowledge Base Entry',
    description: 'Get a specific knowledge base entry by ID, including full content.',
    inputSchema: {
      kb_id: z.string().describe('Knowledge base entry ID'),
    },
  }, async ({ kb_id }) => {
    const r = await apiGet(`/api/kb/${kb_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_create_kb', {
    title: 'Create Knowledge Base Entry',
    description: 'Record a new knowledge base entry (project experience, lesson learned, architecture decision, etc.).',
    inputSchema: {
      title: z.string().describe('Entry title'),
      content: z.string().describe('Entry content (Markdown supported)'),
      project: z.string().describe('Project name'),
      category: z.string().optional().describe('Category (e.g. Architecture, Troubleshooting, API, Design)'),
      tags: z.array(z.string()).optional().describe('Tags array'),
      source: z.string().optional().describe('Source (e.g. associated Goal name or task)'),
    },
  }, async ({ title, content, project, category, tags, source }) => {
    const r = await apiPost('/api/kb', {
      title, content, project, category, tags, source,
    });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_update_kb', {
    title: 'Update Knowledge Base Entry',
    description: 'Update an existing knowledge base entry.',
    inputSchema: {
      kb_id: z.string().describe('Knowledge base entry ID'),
      title: z.string().optional().describe('New title'),
      content: z.string().optional().describe('New content'),
      category: z.string().optional().describe('New category'),
      tags: z.array(z.string()).optional().describe('New tags array'),
      project: z.string().optional().describe('New project'),
      source: z.string().optional().describe('New source'),
    },
  }, async ({ kb_id, ...fields }) => {
    const body = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    const r = await apiPatch(`/api/kb/${kb_id}`, body);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_delete_kb', {
    title: 'Delete Knowledge Base Entry',
    description: 'Delete a knowledge base entry by ID.',
    inputSchema: {
      kb_id: z.string().describe('Knowledge base entry ID'),
    },
  }, async ({ kb_id }) => {
    const r = await apiDelete(`/api/kb/${kb_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
