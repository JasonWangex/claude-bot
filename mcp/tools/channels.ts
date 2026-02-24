/**
 * MCP 工具：Channel 管理（原 Task 管理，实际操作的是 Discord 频道）
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiDelete } from '../api-client.js';

export function registerChannelTools(server: McpServer) {
  server.registerTool('bot_channels', {
    title: 'Channels',
    description: 'Channel management. action: list (all channels), get (by channel_id), delete (by channel_id, cascade optional).',
    inputSchema: {
      action: z.enum(['list', 'get', 'delete']).default('list').describe('Operation type'),
      channel_id: z.string().optional().describe('Channel ID (get/delete)'),
      cascade: z.boolean().optional().describe('Delete child channels too (delete)'),
    },
  }, async ({ action, channel_id, cascade }) => {
    switch (action) {
      case 'list': {
        const r = await apiGet('/api/channels');
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'get': {
        const r = await apiGet(`/api/channels/${channel_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
      case 'delete': {
        const qs = cascade ? '?cascade=true' : '';
        const r = await apiDelete(`/api/channels/${channel_id}${qs}`);
        return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
      }
    }
  });

  server.registerTool('bot_send_message', {
    title: 'Send Message',
    description: 'Send message to a channel thread, triggering Claude to process it.',
    inputSchema: {
      channel_id: z.string().describe('Channel ID'),
      text: z.string().describe('Message text'),
    },
  }, async ({ channel_id, text }) => {
    const r = await apiPost(`/api/channels/${channel_id}/message`, { text });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_qdev', {
    title: 'Quick Dev',
    description: 'Quick-create dev sub-task: auto branch, worktree, Discord channel, trigger Claude.',
    inputSchema: {
      channel_id: z.string().describe('Parent channel ID to create sub-task from'),
      description: z.string().describe('Task description'),
      model: z.string().optional().describe('Claude model to use (e.g. claude-sonnet-4-6, claude-opus-4-6)'),
      category_id: z.string().optional().describe('Discord category ID to create the channel in. Auto-detected from parent channel if omitted.'),
      branch_name: z.string().optional().describe('Custom git branch name (e.g. feat/my-feature). LLM-generated from description if omitted.'),
      channel_name: z.string().optional().describe('Custom Discord channel name. LLM-generated from description if omitted.'),
      base_branch: z.string().optional().describe('Git branch or commit to fork the worktree from. Defaults to current HEAD of the parent session.'),
    },
  }, async ({ channel_id, description, model, category_id, branch_name, channel_name, base_branch }) => {
    const r = await apiPost(`/api/channels/${channel_id}/qdev`, {
      description, model, category_id, branch_name, channel_name, base_branch,
    });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
