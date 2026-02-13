/**
 * MCP 工具：Task 管理
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, apiPost, apiPatch } from '../api-client.js';

export function registerTaskTools(server: McpServer) {
  server.registerTool('bot_list_tasks', {
    title: 'List Tasks',
    description: 'List all Discord Bot tasks (tree structure). Each task is an independent development session with its own working directory and Claude context.',
    inputSchema: {},
  }, async () => {
    const r = await apiGet('/api/tasks');
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_get_task', {
    title: 'Get Task Detail',
    description: 'Get detailed information about a specific task, including name, cwd, model, branch, and session info.',
    inputSchema: {
      task_id: z.string().describe('Discord thread ID (task ID)'),
    },
  }, async ({ task_id }) => {
    const r = await apiGet(`/api/tasks/${task_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_send_message', {
    title: 'Send Message to Task',
    description: 'Send a message to a Discord task thread, which triggers Claude to process it. This is the ONLY tool that produces output in Discord.',
    inputSchema: {
      task_id: z.string().describe('Discord thread ID (task ID)'),
      text: z.string().describe('Message text to send'),
    },
  }, async ({ task_id, text }) => {
    const r = await apiPost(`/api/tasks/${task_id}/message`, { text });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_fork_task', {
    title: 'Fork Task',
    description: 'Fork a task by creating a new git worktree branch and Discord channel. Returns the new task info.',
    inputSchema: {
      task_id: z.string().describe('Parent task ID to fork from'),
      branch_name: z.string().describe('Git branch name for the new worktree'),
      category_id: z.string().describe('Discord category ID for the new channel'),
      thread_title: z.string().optional().describe('Custom title for the new channel'),
    },
  }, async ({ task_id, branch_name, category_id, thread_title }) => {
    const r = await apiPost(`/api/tasks/${task_id}/fork`, {
      branch_name,
      category_id,
      thread_title,
    });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });

  server.registerTool('bot_qdev', {
    title: 'Quick Dev',
    description: 'Quick-create a development sub-task: auto-generates branch name, forks from root task, creates worktree + Discord channel, and triggers Claude with the task description.',
    inputSchema: {
      task_id: z.string().describe('Task ID to create sub-task from'),
      description: z.string().describe('Task description (what to implement/fix)'),
    },
  }, async ({ task_id, description }) => {
    const r = await apiPost(`/api/tasks/${task_id}/qdev`, { description });
    return { content: [{ type: 'text', text: JSON.stringify(r.data ?? r, null, 2) }] };
  });
}
