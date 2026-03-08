/**
 * MCP 工具：Goal 级别事件
 *
 * Claude skill 通过此工具向 Orchestrator 发送 goal 级别信号。
 * 当前支持：goal.drive（触发 Drive 启动）
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiPost } from '../api-client.js';
import { GoalEventType } from '../../discord/db/repo/goal-event-repo.js';

export function registerGoalEventTools(server: McpServer) {
  server.registerTool('bot_goal_event', {
    title: 'Goal Event',
    description:
      'Send a goal-level event to the Orchestrator. ' +
      'Use goal.drive to trigger Drive after tasks have been initialized with bot_goal_tasks(action="set").',
    inputSchema: {
      goal_id: z.string().describe('Goal ID'),
      event_type: z.nativeEnum(GoalEventType).describe('Event type'),
      payload: z
        .object({
          goalName: z.string().min(1).describe('Goal display name'),
          goalChannelId: z.string().describe('Discord channel ID for goal thread'),
          baseCwd: z.string().describe('Base working directory (absolute path)'),
          maxConcurrent: z.number().int().positive().optional().describe('Max concurrent sub-tasks, default 3'),
        })
        .describe('Event payload for goal.drive'),
    },
  }, async ({ goal_id, event_type, payload }) => {
    const r = await apiPost(`/api/goals/${goal_id}/events`, { event_type, payload });
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
