/**
 * IGoalRepo 的 SQLite 实现
 *
 * 管理 Goal Drive 状态的持久化。
 * Goal 存储在 goals 表，tasks 由 TaskRepo 管理，
 * 任务顺序通过 phase 字段控制。
 */

import type Database from 'better-sqlite3';
import type { IGoalRepo } from '../../types/repository.js';
import type { GoalDriveState, GoalDriveStatus, TaskStatus } from '../../types/index.js';
import type { GoalRow, TaskRow } from '../../types/db.js';

export class GoalRepo implements IGoalRepo {
  private db: Database.Database;

  // 预编译语句（懒初始化）
  private stmts!: {
    getGoal: Database.Statement;
    getAllGoals: Database.Statement;
    upsertGoal: Database.Statement;
    deleteGoal: Database.Statement;
    findByDriveStatus: Database.Statement;
    getTasksByGoal: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      getGoal: this.db.prepare(`SELECT * FROM goals WHERE id = ?`),

      getAllGoals: this.db.prepare(`SELECT * FROM goals WHERE drive_status IS NOT NULL`),

      upsertGoal: this.db.prepare(`
        INSERT INTO goals (
          id, name, status,
          drive_status, drive_branch, drive_thread_id, drive_base_cwd,
          drive_max_concurrent, drive_created_at, drive_updated_at,
          drive_pending_json
        ) VALUES (
          @id, @name, COALESCE((SELECT status FROM goals WHERE id = @id), 'Processing'),
          @drive_status, @drive_branch, @drive_thread_id, @drive_base_cwd,
          @drive_max_concurrent, @drive_created_at, @drive_updated_at,
          @drive_pending_json
        )
        ON CONFLICT(id) DO UPDATE SET
          name = @name,
          drive_status = @drive_status,
          drive_branch = @drive_branch,
          drive_thread_id = @drive_thread_id,
          drive_base_cwd = @drive_base_cwd,
          drive_max_concurrent = @drive_max_concurrent,
          drive_created_at = @drive_created_at,
          drive_updated_at = @drive_updated_at,
          drive_pending_json = @drive_pending_json
      `),

      deleteGoal: this.db.prepare(`DELETE FROM goals WHERE id = ?`),

      findByDriveStatus: this.db.prepare(`SELECT * FROM goals WHERE drive_status = ?`),

      getTasksByGoal: this.db.prepare(
        `SELECT * FROM tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
      ),
    };
  }

  async get(goalId: string): Promise<GoalDriveState | null> {
    const row = this.stmts.getGoal.get(goalId) as GoalRow | undefined;
    if (!row || !row.drive_status) return null;

    const taskRows = this.stmts.getTasksByGoal.all(goalId) as TaskRow[];
    return rowsToGoalDriveState(row, taskRows);
  }

  async getAll(): Promise<GoalDriveState[]> {
    const rows = this.stmts.getAllGoals.all() as GoalRow[];
    return rows.map((row) => {
      const taskRows = this.stmts.getTasksByGoal.all(row.id) as TaskRow[];
      return rowsToGoalDriveState(row, taskRows);
    });
  }

  async save(state: GoalDriveState): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      // 1. Upsert goal row
      this.stmts.upsertGoal.run(goalDriveStateToGoalRow(state));

      if (state.tasks.length === 0) {
        // 无任务时直接清空（replan 后任务全部重建的边界情况）
        this.db.prepare(`DELETE FROM tasks WHERE goal_id = ?`).run(state.goalId);
        return;
      }

      // 2. Upsert 各任务（保留行 ID，task_events 不受影响）
      const upsertTask = this.db.prepare(`
        INSERT INTO tasks (
          id, goal_id, description, type, phase, status,
          branch_name, channel_id, dispatched_at, completed_at,
          error, merged, notified_blocked, feedback_json,
          complexity, pipeline_phase, audit_retries,
          tokens_in, tokens_out, cache_read_in, cache_write_in, cost_usd, duration_ms,
          detail_plan, audit_session_key, metadata_json
        ) VALUES (
          @id, @goal_id, @description, @type, @phase, @status,
          @branch_name, @channel_id, @dispatched_at, @completed_at,
          @error, @merged, @notified_blocked, @feedback_json,
          @complexity, @pipeline_phase, @audit_retries,
          @tokens_in, @tokens_out, @cache_read_in, @cache_write_in, @cost_usd, @duration_ms,
          @detail_plan, @audit_session_key, @metadata_json
        )
        ON CONFLICT(id) DO UPDATE SET
          status           = @status,
          description      = @description,
          type             = @type,
          phase            = @phase,
          branch_name      = @branch_name,
          channel_id       = @channel_id,
          dispatched_at    = @dispatched_at,
          completed_at     = @completed_at,
          error            = @error,
          merged           = @merged,
          notified_blocked = @notified_blocked,
          feedback_json    = @feedback_json,
          complexity       = @complexity,
          pipeline_phase   = @pipeline_phase,
          audit_retries    = @audit_retries,
          tokens_in        = @tokens_in,
          tokens_out       = @tokens_out,
          cache_read_in    = @cache_read_in,
          cache_write_in   = @cache_write_in,
          cost_usd         = @cost_usd,
          duration_ms      = @duration_ms,
          detail_plan      = @detail_plan,
          audit_session_key = @audit_session_key,
          metadata_json    = @metadata_json
      `);

      for (const task of state.tasks) {
        upsertTask.run({
          id: task.id,
          goal_id: state.goalId,
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
          detail_plan: task.detailPlan ?? null,
          audit_session_key: task.auditSessionKey ?? null,
          metadata_json: task.metadata ? JSON.stringify(task.metadata) : null,
        });
      }

      // 3. 删除孤儿任务（replan 期间被移除的任务）
      const ids = state.tasks.map(t => t.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM tasks WHERE goal_id = ? AND id NOT IN (${placeholders})`)
        .run(state.goalId, ...ids);
    });

    saveTransaction();
  }

  async delete(goalId: string): Promise<boolean> {
    const result = this.stmts.deleteGoal.run(goalId);
    return result.changes > 0;
  }

  async findByStatus(status: GoalDriveStatus): Promise<GoalDriveState[]> {
    const rows = this.stmts.findByDriveStatus.all(status) as GoalRow[];
    return rows.map((row) => {
      const taskRows = this.stmts.getTasksByGoal.all(row.id) as TaskRow[];
      return rowsToGoalDriveState(row, taskRows);
    });
  }
}

// ==================== 转换函数 ====================

function goalDriveStateToGoalRow(state: GoalDriveState): Record<string, unknown> {
  // 序列化 pendingReplan + pendingRollback + reviewerChannelId 为 JSON
  const pending: Record<string, unknown> = {};
  if (state.pendingReplan) pending.pendingReplan = state.pendingReplan;
  if (state.pendingRollback) pending.pendingRollback = state.pendingRollback;
  if (state.reviewerChannelId) pending.reviewerChannelId = state.reviewerChannelId;
  const pendingJson = Object.keys(pending).length > 0 ? JSON.stringify(pending) : null;

  return {
    id: state.goalId,
    name: state.goalName,
    drive_status: state.status,
    drive_branch: state.goalBranch,
    drive_thread_id: state.goalChannelId,
    drive_base_cwd: state.baseCwd,
    drive_max_concurrent: state.maxConcurrent,
    drive_created_at: state.createdAt,
    drive_updated_at: state.updatedAt,
    drive_pending_json: pendingJson,
  };
}

function rowsToGoalDriveState(
  goal: GoalRow,
  tasks: TaskRow[],
): GoalDriveState {
  // 反序列化 pendingReplan / pendingRollback / reviewerChannelId
  let pendingReplan: GoalDriveState['pendingReplan'];
  let pendingRollback: GoalDriveState['pendingRollback'];
  let reviewerChannelId: string | undefined;
  if (goal.drive_pending_json) {
    try {
      const pending = JSON.parse(goal.drive_pending_json);
      pendingReplan = pending.pendingReplan;
      pendingRollback = pending.pendingRollback;
      reviewerChannelId = pending.reviewerChannelId;
    } catch { /* ignore corrupt JSON */ }
  }

  return {
    goalId: goal.id,
    goalSeq: goal.seq ?? 0,
    goalName: goal.name,
    goalBranch: goal.drive_branch ?? '',
    goalChannelId: goal.drive_thread_id ?? '',
    reviewerChannelId,
    baseCwd: goal.drive_base_cwd ?? '',
    status: (goal.drive_status as GoalDriveStatus) ?? 'running',
    createdAt: goal.drive_created_at ?? 0,
    updatedAt: goal.drive_updated_at ?? 0,
    maxConcurrent: goal.drive_max_concurrent ?? 2,
    pendingReplan,
    pendingRollback,
    tasks: tasks.map((t) => ({
      id: t.id,
      goalId: t.goal_id ?? undefined,
      description: t.description,
      type: t.type,
      phase: t.phase ?? undefined,
      complexity: t.complexity ?? undefined,
      pipelinePhase: (t.pipeline_phase as GoalDriveState['tasks'][number]['pipelinePhase']) ?? undefined,
      auditRetries: t.audit_retries ?? 0,
      status: t.status as TaskStatus,
      branchName: t.branch_name ?? undefined,
      channelId: t.channel_id ?? undefined,
      dispatchedAt: t.dispatched_at ?? undefined,
      completedAt: t.completed_at ?? undefined,
      error: t.error ?? undefined,
      merged: t.merged === 1,
      notifiedBlocked: t.notified_blocked === 1,
      feedback: t.feedback_json ? JSON.parse(t.feedback_json) : undefined,
      tokensIn: t.tokens_in ?? undefined,
      tokensOut: t.tokens_out ?? undefined,
      cacheReadIn: t.cache_read_in ?? undefined,
      cacheWriteIn: t.cache_write_in ?? undefined,
      costUsd: t.cost_usd ?? undefined,
      durationMs: t.duration_ms ?? undefined,
      detailPlan: t.detail_plan ?? undefined,
      auditSessionKey: t.audit_session_key ?? undefined,
      metadata: t.metadata_json ? (() => { try { return JSON.parse(t.metadata_json); } catch { return undefined; } })() : undefined,
    })),
  };
}
