/**
 * MCP 工具：Knowledge Base 知识库管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerKnowledgeBaseTools(server: McpServer) {
  server.registerTool('bot_kb', {
    title: 'Knowledge Base',
    description: 'KB CRUD. list/get/create/update/delete.',
    inputSchema: {
      action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('Operation type'),
      kb_id: z.string().optional().describe('KB entry ID (get/update/delete)'),
      title: z.string().optional().describe('Entry title (create/update)'),
      content: z.string().optional().describe('Markdown content (create/update)'),
      project: z.string().optional().describe('Project name (list/create/update)'),
      category: z.string().optional().describe('Category: Architecture/Troubleshooting/API/Design'),
      q: z.string().optional().describe('Search query (list)'),
      tags: z.array(z.string()).optional().describe('Tags array (create/update)'),
      source: z.string().optional().describe('Source reference (create/update)'),
    },
  }, async ({ action, kb_id, q, ...fields }) => {
    switch (action) {
      case 'list': {
        const params = new URLSearchParams();
        if (fields.project) params.set('project', fields.project);
        if (fields.category) params.set('category', fields.category);
        if (q) params.set('q', q);
        const qs = params.toString();
        const r = await apiGet(`/api/kb${qs ? '?' + qs : ''}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'get': {
        const r = await apiGet(`/api/kb/${kb_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'create': {
        const r = await apiPost('/api/kb', {
          title: fields.title, content: fields.content, project: fields.project,
          category: fields.category, tags: fields.tags, source: fields.source,
        });
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'update': {
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        const r = await apiPatch(`/api/kb/${kb_id}`, body);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'delete': {
        const r = await apiDelete(`/api/kb/${kb_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });
}
