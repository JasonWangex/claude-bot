/**
 * MCP 工具注册中心
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from './tasks.js';
import { registerGoalTools } from './goals.js';
import { registerDataTools } from './data.js';
import { registerSystemTools } from './system.js';
import { registerKnowledgeBaseTools } from './knowledge-base.js';

export function registerAllTools(server: McpServer) {
  registerTaskTools(server);          // 5 tools
  registerGoalTools(server);          // 4 tools
  registerDataTools(server);          // 5 tools
  registerSystemTools(server);        // 2 tools
  registerKnowledgeBaseTools(server); // 5 tools
  // Total: 21 tools
}
