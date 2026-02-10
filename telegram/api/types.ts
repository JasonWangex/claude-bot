/**
 * API 请求/响应类型定义
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import type { TelegramBotConfig } from '../types/index.js';
import type { Telegram } from 'telegraf';

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
  telegram: Telegram;
  config: TelegramBotConfig;
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
  authorized_chat_id: number | null;
  api_port: number;
}

// ========== Topic ==========

export interface TopicSummary {
  topic_id: number;
  name: string;
  cwd: string;
  model: string | null;
  has_session: boolean;
  message_count: number;
  last_active: string | null;
  parent_topic_id: number | null;
  worktree_branch: string | null;
  children: TopicSummary[];
}

export interface TopicDetail extends TopicSummary {
  claude_session_id: string | null;
  created_at: string;
  plan_mode: boolean;
}

export interface CreateTopicRequest {
  name: string;
  cwd?: string;
}

export interface CreateTopicResponse {
  topic_id: number;
  name: string;
  cwd: string;
}

export interface UpdateTopicRequest {
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

// ========== 状态 ==========

export interface StatusResponse {
  default_cwd: string;
  default_model: string | null;
  active_topics: number;
  topics: TopicSummary[];
}

