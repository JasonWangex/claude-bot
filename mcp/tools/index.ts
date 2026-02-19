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
  registerTaskTools(server);          // 3 tools: bot_tasks, bot_send_message, bot_qdev
  registerGoalTools(server);          // 1 tool:  bot_goals
  registerDataTools(server);          // 2 tools: bot_devlogs, bot_ideas
  registerSystemTools(server);        // 1 tool:  bot_status
  registerKnowledgeBaseTools(server); // 1 tool:  bot_kb
  // Total: 8 tools (consolidated from 21)
}
