/**
 * MCP 工具：系统状态
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet } from '../api-client.js';

export function registerSystemTools(server: McpServer) {
  server.registerTool('bot_status', {
    title: 'Bot Status',
    description: 'Bot global status: active tasks, default cwd/model, available models.',
    inputSchema: {},
  }, async () => {
    const [status, models] = await Promise.all([
      apiGet('/api/status'),
      apiGet('/api/models'),
    ]);
    const result = {
      ...(status.data ?? status),
      models: models.data ?? models,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}
