/**
 * API 请求/响应类型定义（Discord 版）
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Client } from 'discord.js';
import type { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import type { MessageQueue } from '../bot/message-queue.js';
import type { DiscordBotConfig } from '../types/index.js';
import type { GoalOrchestrator } from '../orchestrator/index.js';

// ========== 通用 ==========

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ========== 依赖注入 ==========

export interface ApiDeps {
  stateManager: StateManager;
  claudeClient: ClaudeClient;
  messageHandler: MessageHandler;
  client: Client;
  mq: MessageQueue;
  config: DiscordBotConfig;
  orchestrator?: GoalOrchestrator;
}

// ========== 路由 ==========

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: ApiDeps,
) => Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

// ========== 健康检查 ==========

export interface HealthData {
  status: 'running';
  authorized_guild_id: string | null;
  api_port: number;
}

// ========== Task (Channel) ==========

export interface TaskSummary {
  thread_id: string;
  name: string;
  cwd: string;
  model: string | null;
  has_session: boolean;
  message_count: number;
  last_active: string | null;
  parent_thread_id: string | null;
  worktree_branch: string | null;
  children: TaskSummary[];
}

export interface TaskDetail extends TaskSummary {
  claude_session_id: string | null;
  created_at: string;
  plan_mode: boolean;
}

export interface CreateTaskRequest {
  name: string;
  cwd?: string;
  category?: string;
}

export interface CreateTaskResponse {
  thread_id: string;
  name: string;
  cwd: string;
}

export interface UpdateTaskRequest {
  name?: string;
  model?: string | null;
  cwd?: string;
}

// ========== 消息 ==========

export interface SendMessageRequest {
  text: string;
  plan_mode?: boolean;
}

export interface SendMessageResponse {
  result: string;
  session_id: string;
  duration_ms: number | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

// ========== Session 操作 ==========

export interface SessionOpResponse {
  success: boolean;
  message?: string;
  session_id?: string;
}

// ========== 模型 ==========

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
  default_model: string | null;
}

export interface SetDefaultModelRequest {
  model: string;
}

// ========== Fork Task ==========

export interface ForkTaskRequest {
  branch_name: string;
  category_id: string;
  thread_title?: string;
}

export interface ForkTaskResponse {
  thread_id: string;
  thread_name: string;
  branch_name: string;
  cwd: string;
}

// ========== Qdev ==========

export interface QdevRequest {
  description: string;
}

export interface QdevResponse {
  thread_id: string;
  thread_name: string;
  branch_name: string;
  cwd: string;
}

// ========== Ideas ==========

export interface CreateIdeaRequest {
  name: string;
  project: string;
  status?: string;   // IdeaStatus, default 'Idea'
}

export interface UpdateIdeaRequest {
  name?: string;
  status?: string;   // IdeaStatus
  project?: string;
}

// ========== 状态 ==========

export interface StatusResponse {
  default_cwd: string;
  default_model: string | null;
  active_tasks: number;
  tasks: TaskSummary[];
}
