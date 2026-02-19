/**
 * claude-bot MCP Server — stdio transport
 *
 * Claude Code 以子进程方式管理本 server，通过 stdin/stdout 通信。
 * 工具调用通过 HTTP 调用 Bot API (127.0.0.1:3456) 实现。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';

const server = new McpServer(
  { name: 'claude-bot', version: '1.0.0' },
  { capabilities: { logging: {} } },
);

registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
