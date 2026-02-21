/**
 * ClaudeSessionRepository
 *
 * 管理 Claude CLI 会话实体的 CRUD（同步接口，基于 better-sqlite3）。
 * 主键: claude_session_id (Claude CLI session_id)
 */

import type Database from 'better-sqlite3';
import type { ClaudeSession } from '../../types/index.js';
import type { ClaudeSessionRow } from '../../types/db.js';
import { logger } from '../../utils/logger.js';

// ==================== 转换函数 ====================

function rowToClaudeSession(row: ClaudeSessionRow): ClaudeSession {
  return {
    claudeSessionId: row.claude_session_id,
    prevClaudeSessionId: row.prev_claude_session_id ?? undefined,
    channelId: row.channel_id ?? undefined,
    model: row.model ?? undefined,
    planMode: row.plan_mode === 1,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
    purpose: row.purpose ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    lastActivityAt: row.last_activity_at ?? undefined,
    lastUsageJson: row.last_usage_json ?? undefined,
    lastStopAt: row.last_stop_at ?? undefined,
    title: row.title ?? undefined,
    taskId: row.task_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    cwd: row.cwd ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    projectPath: row.project_path ?? undefined,
    tokensIn: row.tokens_in || undefined,
    tokensOut: row.tokens_out || undefined,
    cacheReadIn: row.cache_read_in || undefined,
    cacheWriteIn: row.cache_write_in || undefined,
    costUsd: row.cost_usd || undefined,
    turnCount: row.turn_count || undefined,
    usageFileOffset: row.usage_file_offset || undefined,
    modelUsage: row.model_usage ? JSON.parse(row.model_usage) : undefined,
    hidden: (row.hidden ?? 0) === 1,
  };
}

function claudeSessionToParams(session: ClaudeSession): Record<string, unknown> {
  return {
    claude_session_id: session.claudeSessionId,
    prev_claude_session_id: session.prevClaudeSessionId ?? null,
    channel_id: session.channelId ?? null,
    model: session.model ?? null,
    plan_mode: session.planMode ? 1 : 0,
    status: session.status,
    created_at: session.createdAt,
    closed_at: session.closedAt ?? null,
    purpose: session.purpose ?? null,
    parent_session_id: session.parentSessionId ?? null,
    last_activity_at: session.lastActivityAt ?? null,
    last_usage_json: session.lastUsageJson ?? null,
    last_stop_at: session.lastStopAt ?? null,
    title: session.title ?? null,
    task_id: session.taskId ?? null,
    goal_id: session.goalId ?? null,
    cwd: session.cwd ?? null,
    git_branch: session.gitBranch ?? null,
    project_path: session.projectPath ?? null,
    hidden: session.hidden ? 1 : 0,
  };
}

// ==================== Repository 实现 ====================

export class ClaudeSessionRepository {
  private stmts!: {
    get: Database.Statement;
    getByChannel: Database.Statement;
    getActiveByChannel: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    close: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      get: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE claude_session_id = ?`,
      ),

      getByChannel: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE channel_id = ? ORDER BY created_at DESC`,
      ),

      getActiveByChannel: this.db.prepare(
        `SELECT * FROM claude_sessions WHERE channel_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      ),

      getAll: this.db.prepare(`SELECT * FROM claude_sessions`),

      upsert: this.db.prepare(`
        INSERT INTO claude_sessions (
          claude_session_id, prev_claude_session_id,
          channel_id, model, plan_mode, status, created_at, closed_at,
          purpose, parent_session_id, last_activity_at, last_usage_json, last_stop_at, title,
          task_id, goal_id, cwd, git_branch, project_path, hidden
        ) VALUES (
          @claude_session_id, @prev_claude_session_id,
          @channel_id, @model, @plan_mode, @status, @created_at, @closed_at,
          @purpose, @parent_session_id, @last_activity_at, @last_usage_json, @last_stop_at, @title,
          @task_id, @goal_id, @cwd, @git_branch, @project_path, @hidden
        )
        ON CONFLICT(claude_session_id) DO UPDATE SET
          prev_claude_session_id = @prev_claude_session_id,
          channel_id = @channel_id,
          model = @model,
          plan_mode = @plan_mode,
          status = @status,
          closed_at = @closed_at,
          purpose = @purpose,
          parent_session_id = @parent_session_id,
          last_activity_at = @last_activity_at,
          last_usage_json = @last_usage_json,
          last_stop_at = @last_stop_at,
          title = COALESCE(@title, title),
          task_id = COALESCE(@task_id, task_id),
          goal_id = COALESCE(@goal_id, goal_id),
          cwd = COALESCE(@cwd, cwd),
          git_branch = COALESCE(@git_branch, git_branch),
          project_path = COALESCE(@project_path, project_path),
          hidden = @hidden
      `),

      close: this.db.prepare(`
        UPDATE claude_sessions
        SET status = 'closed', closed_at = ?
        WHERE claude_session_id = ?
      `),
    };
  }

  // ==================== 同步 CRUD ====================

  get(claudeSessionId: string): ClaudeSession | null {
    const row = this.stmts.get.get(claudeSessionId) as ClaudeSessionRow | undefined;
    return row ? rowToClaudeSession(row) : null;
  }

  getByChannel(channelId: string): ClaudeSession[] {
    const rows = this.stmts.getByChannel.all(channelId) as ClaudeSessionRow[];
    return rows.map(rowToClaudeSession);
  }

  getActiveByChannel(channelId: string): ClaudeSession | null {
    const row = this.stmts.getActiveByChannel.get(channelId) as ClaudeSessionRow | undefined;
    return row ? rowToClaudeSession(row) : null;
  }

  save(session: ClaudeSession): void {
    try {
      this.stmts.upsert.run(claudeSessionToParams(session));
    } catch (err: any) {
      logger.error(`[ClaudeSessionRepo] save failed: claude_session_id=${session.claudeSessionId}, code=${err.code}`, err.message);
    }
  }

  close(claudeSessionId: string): boolean {
    const result = this.stmts.close.run(Date.now(), claudeSessionId);
    return result.changes > 0;
  }

  /** 加载所有 claude_sessions，用于启动时填充内存 */
  loadAll(): ClaudeSession[] {
    const rows = this.stmts.getAll.all() as ClaudeSessionRow[];
    return rows.map(rowToClaudeSession);
  }
}
