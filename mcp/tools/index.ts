/**
 * MCP 工具注册中心
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from './tasks.js';
import { registerGoalTools } from './goals.js';
import { registerDataTools } from './data.js';
import { registerSystemTools } from './system.js';

export function registerAllTools(server: McpServer) {
  registerTaskTools(server);   // 5 tools
  registerGoalTools(server);   // 4 tools
  registerDataTools(server);   // 5 tools
  registerSystemTools(server); // 2 tools
  // Total: 16 tools
}
