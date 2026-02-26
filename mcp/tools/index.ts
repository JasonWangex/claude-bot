/**
 * MCP 工具注册中心
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerChannelTools } from './channels.js';
import { registerGoalTools } from './goals.js';
import { registerGoalTaskTools } from './goal-tasks.js';
import { registerDataTools } from './data.js';
import { registerSystemTools } from './system.js';
import { registerKnowledgeBaseTools } from './knowledge-base.js';
import { registerGoalTodoTools } from './goal-todos.js';
import { registerTaskEventTools } from './task-event.js';
import { registerGoalEventTools } from './goal-event.js';

export function registerAllTools(server: McpServer) {
  registerChannelTools(server);       // 3 tools: bot_channels (list/get/delete), bot_send_message, bot_qdev
  registerGoalTools(server);          // 1 tool:  bot_goals (list/get/create/update)
  registerGoalTaskTools(server);      // 1 tool:  bot_goal_tasks (list/set/skip/done/retry/reset/pause/nudge)
  registerGoalTodoTools(server);      // 1 tool:  bot_goal_todos (list/add/done/undone/delete)
  registerDataTools(server);          // 2 tools: bot_devlogs, bot_ideas
  registerSystemTools(server);        // 1 tool:  bot_status
  registerKnowledgeBaseTools(server); // 1 tool:  bot_kb
  registerTaskEventTools(server);     // 1 tool:  bot_task_event (write-only)
  registerGoalEventTools(server);     // 1 tool:  bot_goal_event (goal.drive)
  // Total: 12 tools
}
