/**
 * MCP 工具：系统状态
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet } from '../api-client.js';

export function registerSystemTools(server: McpServer) {
  server.registerTool('bot_status', {
    title: 'Bot Status',
    description: 'Get Discord Bot global status: active tasks, default cwd, default model.',
    inputSchema: {},
  }, async () => {
    const r = await apiGet('/api/status');
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_list_models', {
    title: 'List Models',
    description: 'List available Claude models and the current global default model.',
    inputSchema: {},
  }, async () => {
    const r = await apiGet('/api/models');
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
