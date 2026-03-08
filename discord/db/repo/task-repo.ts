/**
 * ITaskRepo 的 SQLite 实现
 *
 * 管理独立 Task 和 Goal 子任务的统一仓库。
 * 主键: id (全局唯一，migration 010 后改为单列主键)
 * goalId 为可选字段（null 表示独立任务，如 qdev）
 * 任务顺序通过 phase 字段控制，无显式依赖关系。
 */

import type Database from 'better-sqlite3';
import type { ITaskRepo } from '../../types/repository.js';
import type { Task, ChatUsageResult } from '../../types/index.js';
import { TaskStatus, TaskType, TaskComplexity, PipelinePhase } from '../../types/index.js';
import type { TaskRow } from '../../types/db.js';

export class TaskRepo implements ITaskRepo {
  private db: Database.Database;

  private stmts!: {
    getTask: Database.Statement;
    getTasksByGoal: Database.Statement;
    upsertTask: Database.Statement;
    deleteTask: Database.Statement;
    deleteAllByGoal: Database.Statement;
    findByStatus: Database.Statement;
    findByChannelId: Database.Statement;
    patchCheckin: Database.Statement;
    patchNudge: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      getTask: this.db.prepare(
        `SELECT * FROM tasks WHERE id = ?`,
      ),

      getTasksByGoal: this.db.prepare(
        `SELECT * FROM tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
      ),

      upsertTask: this.db.prepare(`
        INSERT INTO tasks (
          id, goal_id, description, type, phase, status,
          branch_name, channel_id, dispatched_at, completed_at,
          error, merged, notified_blocked, feedback_json,
          complexity, pipeline_phase, audit_retries,
          tokens_in, tokens_out, cache_read_in, cache_write_in, cost_usd, duration_ms,
          audit_session_key,
          checkin_count, last_checkin_at, nudge_count, last_nudge_at
        ) VALUES (
          @id, @goal_id, @description, @type, @phase, @status,
          @branch_name, @channel_id, @dispatched_at, @completed_at,
          @error, @merged, @notified_blocked, @feedback_json,
          @complexity, @pipeline_phase, @audit_retries,
          @tokens_in, @tokens_out, @cache_read_in, @cache_write_in, @cost_usd, @duration_ms,
          @audit_session_key,
          @checkin_count, @last_checkin_at, @nudge_count, @last_nudge_at
        )
        ON CONFLICT(id) DO UPDATE SET
          goal_id = @goal_id,
          description = @description,
          type = @type,
          phase = @phase,
          status = @status,
          branch_name = @branch_name,
          channel_id = @channel_id,
          dispatched_at = @dispatched_at,
          completed_at = @completed_at,
          error = @error,
          merged = @merged,
          notified_blocked = @notified_blocked,
          feedback_json = @feedback_json,
          complexity = @complexity,
          pipeline_phase = @pipeline_phase,
          audit_retries = @audit_retries,
          tokens_in = @tokens_in,
          tokens_out = @tokens_out,
          cache_read_in = @cache_read_in,
          cache_write_in = @cache_write_in,
          cost_usd = @cost_usd,
          duration_ms = @duration_ms,
          audit_session_key = @audit_session_key,
          checkin_count = @checkin_count,
          last_checkin_at = @last_checkin_at,
          nudge_count = @nudge_count,
          last_nudge_at = @last_nudge_at
      `),

      deleteTask: this.db.prepare(
        `DELETE FROM tasks WHERE id = ?`,
      ),

      deleteAllByGoal: this.db.prepare(
        `DELETE FROM tasks WHERE goal_id = ?`,
      ),

      findByStatus: this.db.prepare(
        `SELECT * FROM tasks WHERE goal_id = ? AND status = ? ORDER BY phase ASC, id ASC`,
      ),

      findByChannelId: this.db.prepare(
        `SELECT * FROM tasks WHERE channel_id = ?`,
      ),

      patchCheckin: this.db.prepare(
        `UPDATE tasks SET checkin_count = ?, last_checkin_at = ? WHERE id = ?`,
      ),

      patchNudge: this.db.prepare(
        `UPDATE tasks SET nudge_count = ?, last_nudge_at = ? WHERE id = ?`,
      ),
    };
  }

  async getById(taskId: string): Promise<Task | null> {
    const row = this.stmts.getTask.get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return rowToTask(row);
  }

  async getAllByGoal(goalId: string): Promise<Task[]> {
    const rows = this.stmts.getTasksByGoal.all(goalId) as TaskRow[];
    return rows.map((row) => rowToTask(row));
  }

  async save(task: Task, goalId?: string | null): Promise<void> {
    this.stmts.upsertTask.run(taskToRow(task, goalId));
  }

  async saveAll(tasks: Task[], goalId?: string | null): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      // 如果有 goalId，先清除该 goal 下所有任务
      if (goalId) {
        this.stmts.deleteAllByGoal.run(goalId);
      }

      // 重新插入
      for (const task of tasks) {
        this.stmts.upsertTask.run(taskToRow(task, goalId));
      }
    });

    saveTransaction();
  }

  async delete(taskId: string): Promise<boolean> {
    const result = this.stmts.deleteTask.run(taskId);
    return result.changes > 0;
  }

  async deleteAllByGoal(goalId: string): Promise<void> {
    this.stmts.deleteAllByGoal.run(goalId);
  }

  async findByStatus(goalId: string, status: TaskStatus): Promise<Task[]> {
    const rows = this.stmts.findByStatus.all(goalId, status) as TaskRow[];
    return rows.map((row) => rowToTask(row));
  }

  async findByChannelId(channelId: string): Promise<{ goalId: string | null; task: Task } | null> {
    const row = this.stmts.findByChannelId.get(channelId) as TaskRow | undefined;
    if (!row) return null;
    return {
      goalId: row.goal_id,
      task: rowToTask(row),
    };
  }

  /** 聚合 Goal 下所有 task 的 token/cost/time 总量 */
  getGoalUsageTotals(goalId: string): ChatUsageResult {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(tokens_in), 0)      AS tokens_in,
        COALESCE(SUM(tokens_out), 0)     AS tokens_out,
        COALESCE(SUM(cache_read_in), 0)  AS cache_read_in,
        COALESCE(SUM(cache_write_in), 0) AS cache_write_in,
        COALESCE(SUM(cost_usd), 0)       AS cost_usd,
        COALESCE(SUM(duration_ms), 0)    AS duration_ms
      FROM tasks
      WHERE goal_id = ?
    `).get(goalId) as Record<string, number>;

    return {
      input_tokens: row.tokens_in,
      output_tokens: row.tokens_out,
      cache_read_input_tokens: row.cache_read_in,
      cache_creation_input_tokens: row.cache_write_in,
      total_cost_usd: row.cost_usd,
      duration_ms: row.duration_ms,
    };
  }

  /** 更新 check-in 计数和时间戳（直接 SQL，不走全量 upsert） */
  patchCheckin(taskId: string, count: number, at: number | null): void {
    this.stmts.patchCheckin.run(count, at, taskId);
  }

  /** 更新 tech lead 轻推计数和时间戳（直接 SQL，不走全量 upsert） */
  patchNudge(taskId: string, count: number, at: number | null): void {
    this.stmts.patchNudge.run(count, at, taskId);
  }
}

// ==================== 转换函数 ====================

function taskToRow(task: Task, goalId?: string | null): Record<string, unknown> {
  const effectiveGoalId = goalId ?? task.goalId ?? null;
  return {
    id: task.id,
    goal_id: effectiveGoalId,
    description: task.description,
    type: task.type,
    phase: task.phase ?? null,
    status: task.status,
    branch_name: task.branchName ?? null,
    channel_id: task.channelId ?? null,
    dispatched_at: task.dispatchedAt ?? null,
    completed_at: task.completedAt ?? null,
    error: task.error ?? null,
    merged: task.merged ? 1 : 0,
    notified_blocked: task.notifiedBlocked ? 1 : 0,
    feedback_json: task.feedback ? JSON.stringify(task.feedback) : null,
    complexity: task.complexity ?? null,
    pipeline_phase: task.pipelinePhase ?? null,
    audit_retries: task.auditRetries ?? 0,
    tokens_in: task.tokensIn ?? null,
    tokens_out: task.tokensOut ?? null,
    cache_read_in: task.cacheReadIn ?? null,
    cache_write_in: task.cacheWriteIn ?? null,
    cost_usd: task.costUsd ?? null,
    duration_ms: task.durationMs ?? null,
    audit_session_key: task.auditSessionKey ?? null,
    checkin_count: task.checkinCount ?? 0,
    last_checkin_at: task.lastCheckinAt ?? null,
    nudge_count: task.nudgeCount ?? 0,
    last_nudge_at: task.lastNudgeAt ?? null,
  };
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    goalId: row.goal_id ?? undefined,
    description: row.description,
    type: row.type as TaskType,
    phase: row.phase ?? undefined,
    complexity: row.complexity as TaskComplexity ?? undefined,
    pipelinePhase: validatePipelinePhase(row.pipeline_phase),
    auditRetries: row.audit_retries ?? 0,
    status: row.status as TaskStatus,
    branchName: row.branch_name ?? undefined,
    channelId: row.channel_id ?? undefined,
    dispatchedAt: row.dispatched_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    merged: row.merged === 1,
    notifiedBlocked: row.notified_blocked === 1,
    feedback: row.feedback_json ? JSON.parse(row.feedback_json) : undefined,
    tokensIn: row.tokens_in ?? undefined,
    tokensOut: row.tokens_out ?? undefined,
    cacheReadIn: row.cache_read_in ?? undefined,
    cacheWriteIn: row.cache_write_in ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    auditSessionKey: row.audit_session_key ?? undefined,
    checkinCount: row.checkin_count ?? 0,
    lastCheckinAt: row.last_checkin_at ?? null,
    nudgeCount: row.nudge_count ?? 0,
    lastNudgeAt: row.last_nudge_at ?? null,
  };
}

const VALID_PIPELINE_PHASES: PipelinePhase[] = [PipelinePhase.Execute];

function validatePipelinePhase(value: string | null): PipelinePhase | undefined {
  if (!value) return undefined;
  return VALID_PIPELINE_PHASES.includes(value as PipelinePhase)
    ? (value as PipelinePhase)
    : undefined;
}

