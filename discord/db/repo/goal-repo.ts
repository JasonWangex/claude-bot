/**
 * IGoalRepo 的 SQLite 实现
 *
 * 管理 Goal Drive 状态的持久化。
 * Goal 存储在 goals 表，tasks 和 deps 由 GoalTaskRepo 管理，
 * 但 get/getAll 需要联合查询 tasks + deps 来组装完整的 GoalDriveState。
 */

import type Database from 'better-sqlite3';
import type { IGoalRepo } from '../../types/repository.js';
import type { GoalDriveState, GoalDriveStatus } from '../../types/index.js';
import type { GoalRow, GoalTaskRow, GoalTaskDepRow } from '../../types/db.js';

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
    getDepsByGoal: Database.Statement;
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
          @id, @name, COALESCE((SELECT status FROM goals WHERE id = @id), 'Active'),
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
        `SELECT * FROM goal_tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
      ),

      getDepsByGoal: this.db.prepare(`SELECT * FROM goal_task_deps WHERE goal_id = ?`),
    };
  }

  async get(goalId: string): Promise<GoalDriveState | null> {
    const row = this.stmts.getGoal.get(goalId) as GoalRow | undefined;
    if (!row || !row.drive_status) return null;

    const taskRows = this.stmts.getTasksByGoal.all(goalId) as GoalTaskRow[];
    const depRows = this.stmts.getDepsByGoal.all(goalId) as GoalTaskDepRow[];

    return rowsToGoalDriveState(row, taskRows, depRows);
  }

  async getAll(): Promise<GoalDriveState[]> {
    const rows = this.stmts.getAllGoals.all() as GoalRow[];
    return rows.map((row) => {
      const taskRows = this.stmts.getTasksByGoal.all(row.id) as GoalTaskRow[];
      const depRows = this.stmts.getDepsByGoal.all(row.id) as GoalTaskDepRow[];
      return rowsToGoalDriveState(row, taskRows, depRows);
    });
  }

  async save(state: GoalDriveState): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      // 1. Upsert goal row
      this.stmts.upsertGoal.run(goalDriveStateToGoalRow(state));

      // 2. Replace tasks: delete all then re-insert
      this.db.prepare(`DELETE FROM goal_tasks WHERE goal_id = ?`).run(state.goalId);

      if (state.tasks.length > 0) {
        const insertTask = this.db.prepare(`
          INSERT INTO goal_tasks (
            id, goal_id, description, type, phase, status,
            branch_name, thread_id, dispatched_at, completed_at,
            error, merged, notified_blocked, feedback_json,
            complexity, pipeline_phase, audit_retries,
            tokens_in, tokens_out, cache_read_in, cache_write_in, cost_usd, duration_ms
          ) VALUES (
            @id, @goal_id, @description, @type, @phase, @status,
            @branch_name, @thread_id, @dispatched_at, @completed_at,
            @error, @merged, @notified_blocked, @feedback_json,
            @complexity, @pipeline_phase, @audit_retries,
            @tokens_in, @tokens_out, @cache_read_in, @cache_write_in, @cost_usd, @duration_ms
          )
        `);

        const insertDep = this.db.prepare(`
          INSERT INTO goal_task_deps (goal_id, task_id, depends_on_task_id)
          VALUES (?, ?, ?)
        `);

        for (const task of state.tasks) {
          insertTask.run({
            id: task.id,
            goal_id: state.goalId,
            description: task.description,
            type: task.type,
            phase: task.phase ?? null,
            status: task.status,
            branch_name: task.branchName ?? null,
            thread_id: task.threadId ?? null,
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
          });

          for (const dep of task.depends) {
            insertDep.run(state.goalId, task.id, dep);
          }
        }
      }
    });

    saveTransaction();
  }

  async delete(goalId: string): Promise<boolean> {
    // CASCADE 会自动删除 goal_tasks 和 goal_task_deps
    const result = this.stmts.deleteGoal.run(goalId);
    return result.changes > 0;
  }

  async findByStatus(status: GoalDriveStatus): Promise<GoalDriveState[]> {
    const rows = this.stmts.findByDriveStatus.all(status) as GoalRow[];
    return rows.map((row) => {
      const taskRows = this.stmts.getTasksByGoal.all(row.id) as GoalTaskRow[];
      const depRows = this.stmts.getDepsByGoal.all(row.id) as GoalTaskDepRow[];
      return rowsToGoalDriveState(row, taskRows, depRows);
    });
  }
}

// ==================== 转换函数 ====================

function goalDriveStateToGoalRow(state: GoalDriveState): Record<string, unknown> {
  // 序列化 pendingReplan + pendingRollback 为 JSON
  const pending: Record<string, unknown> = {};
  if (state.pendingReplan) pending.pendingReplan = state.pendingReplan;
  if (state.pendingRollback) pending.pendingRollback = state.pendingRollback;
  const pendingJson = Object.keys(pending).length > 0 ? JSON.stringify(pending) : null;

  return {
    id: state.goalId,
    name: state.goalName,
    drive_status: state.status,
    drive_branch: state.goalBranch,
    drive_thread_id: state.goalThreadId,
    drive_base_cwd: state.baseCwd,
    drive_max_concurrent: state.maxConcurrent,
    drive_created_at: state.createdAt,
    drive_updated_at: state.updatedAt,
    drive_pending_json: pendingJson,
  };
}

function rowsToGoalDriveState(
  goal: GoalRow,
  tasks: GoalTaskRow[],
  deps: GoalTaskDepRow[],
): GoalDriveState {
  // 建立 taskId → depends 映射
  const depsMap = new Map<string, string[]>();
  for (const dep of deps) {
    const list = depsMap.get(dep.task_id) || [];
    list.push(dep.depends_on_task_id);
    depsMap.set(dep.task_id, list);
  }

  // 反序列化 pendingReplan / pendingRollback
  let pendingReplan: GoalDriveState['pendingReplan'];
  let pendingRollback: GoalDriveState['pendingRollback'];
  if (goal.drive_pending_json) {
    try {
      const pending = JSON.parse(goal.drive_pending_json);
      pendingReplan = pending.pendingReplan;
      pendingRollback = pending.pendingRollback;
    } catch { /* ignore corrupt JSON */ }
  }

  return {
    goalId: goal.id,
    goalSeq: goal.seq ?? 0,
    goalName: goal.name,
    goalBranch: goal.drive_branch ?? '',
    goalThreadId: goal.drive_thread_id ?? '',
    baseCwd: goal.drive_base_cwd ?? '',
    status: (goal.drive_status as GoalDriveStatus) ?? 'running',
    createdAt: goal.drive_created_at ?? 0,
    updatedAt: goal.drive_updated_at ?? 0,
    maxConcurrent: goal.drive_max_concurrent ?? 2,
    pendingReplan,
    pendingRollback,
    tasks: tasks.map((t) => ({
      id: t.id,
      description: t.description,
      type: t.type,
      depends: depsMap.get(t.id) || [],
      phase: t.phase ?? undefined,
      complexity: t.complexity ?? undefined,
      pipelinePhase: (t.pipeline_phase as GoalDriveState['tasks'][number]['pipelinePhase']) ?? undefined,
      auditRetries: t.audit_retries ?? 0,
      status: t.status,
      branchName: t.branch_name ?? undefined,
      threadId: t.thread_id ?? undefined,
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
    })),
  };
}
