/**
 * API 请求/响应类型定义（Discord 版）
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type Database from 'better-sqlite3';
import type { Client } from 'discord.js';
import type { StateManager } from '../bot/state.js';
import type { ClaudeClient } from '../claude/client.js';
import type { MessageHandler } from '../bot/handlers.js';
import type { MessageQueue } from '../bot/message-queue.js';
import type { DiscordBotConfig } from '../types/index.js';
import type { GoalOrchestrator } from '../orchestrator/index.js';
import type { GoalStatus, GoalType } from '../types/db.js';
import type { SessionSyncService } from '../sync/session-sync-service.js';
import type { ChannelService } from '../services/channel-service.js';
import type { PromptConfigService } from '../services/prompt-config-service.js';

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
  db: Database.Database;
  orchestrator?: GoalOrchestrator;
  sessionSyncService?: SessionSyncService;
  channelService?: ChannelService;
  promptService: PromptConfigService;
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

// ========== Channel ==========

export interface ChannelSummary {
  channel_id: string;
  name: string;
  cwd: string;
  model: string | null;
  has_session: boolean;
  message_count: number;
  created_at: number;
  last_message: string | null;
  last_message_at: number | null;
  parent_channel_id: string | null;
  worktree_branch: string | null;
  status: 'active' | 'archived';
  children: ChannelSummary[];
}

export interface ChannelDetail extends ChannelSummary {
  claude_session_id: string | null;
  plan_mode: boolean;
}

export interface CreateChannelRequest {
  name: string;
  cwd?: string;
  category?: string;
}

export interface CreateChannelResponse {
  channel_id: string;
  name: string;
  cwd: string;
}

export interface UpdateChannelRequest {
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

// ========== Fork Channel ==========

export interface ForkChannelRequest {
  branch_name: string;
  category_id: string;
  thread_title?: string;
}

export interface ForkChannelResponse {
  channel_id: string;
  channel_name: string;
  branch_name: string;
  cwd: string;
}

// ========== Qdev ==========

export interface QdevRequest {
  description: string;
}

export interface QdevResponse {
  channel_id: string;
  channel_name: string;
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
  active_channels: number;
  channels: ChannelSummary[];
}

// ========== Goal CRUD ==========

export interface GoalSummary {
  id: string;
  name: string;
  status: GoalStatus;
  type: GoalType | null;
  project: string | null;
  date: string | null;
  progress: string | null;
  drive_status: string | null;
}

export interface GoalDetail extends GoalSummary {
  completion: string | null;
  next: string | null;
  blocked_by: string | null;
  body: string | null;
  drive_branch: string | null;
  drive_channel_id: string | null;
  drive_base_cwd: string | null;
  drive_max_concurrent: number | null;
  drive_created_at: number | null;
  drive_updated_at: number | null;
  tasks: GoalTaskSummary[];
}

export interface GoalTaskSummary {
  id: string;
  description: string;
  type: string;
  phase: number | null;
  complexity: string | null;
  pipeline_phase: string | null;
  audit_retries: number;
  status: string;
  depends: string[];
  branch_name: string | null;
  channel_id: string | null;
}

export interface CreateGoalRequest {
  name: string;
  status?: GoalStatus;
  type?: GoalType;
  project?: string;
  completion?: string;
  body?: string;
}

export interface UpdateGoalRequest {
  name?: string;
  status?: GoalStatus;
  type?: GoalType;
  project?: string;
  date?: string;
  completion?: string;
  progress?: string;
  next?: string;
  blocked_by?: string;
  body?: string;
}
