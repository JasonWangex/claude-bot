/**
 * GoalCheckpoint SQLite Repository 实现
 *
 * 实现 IGoalCheckpointRepo 接口，提供快照检查点的 CRUD 和业务操作。
 *
 * 保留策略：
 * - 每 Goal 最多保留 10 个快照（save 时自动淘汰最旧的）
 * - Goal 完成后可调用 compressForCompletedGoal() 压缩为只保留首末两个
 */

import type Database from 'better-sqlite3';
import type { IGoalCheckpointRepo } from '../../types/repository.js';
import type { GoalCheckpoint, GoalTask } from '../../types/index.js';
import type { GoalCheckpointRow } from '../../types/db.js';

const MAX_CHECKPOINTS_PER_GOAL = 10;

/** GoalCheckpointRow → GoalCheckpoint */
function rowToCheckpoint(row: GoalCheckpointRow): GoalCheckpoint {
  return {
    id: row.id,
    goalId: row.goal_id,
    trigger: row.trigger,
    triggerTaskId: row.trigger_task_id ?? undefined,
    reason: row.reason ?? undefined,
    tasksSnapshot: row.tasks_snapshot ? JSON.parse(row.tasks_snapshot) : undefined,
    gitRef: row.git_ref ?? undefined,
    changeSummary: row.change_summary ?? undefined,
    createdAt: row.created_at,
  };
}

export class CheckpointRepo implements IGoalCheckpointRepo {
  private stmts: {
    get: Database.Statement;
    getByGoal: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    countByGoal: Database.Statement;
    getOldestByGoal: Database.Statement;
    getFirstAndLastByGoal: Database.Statement;
    deleteByGoalExcept: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM goal_checkpoints WHERE id = ?'),

      getByGoal: db.prepare(
        'SELECT * FROM goal_checkpoints WHERE goal_id = ? ORDER BY created_at DESC',
      ),

      upsert: db.prepare(`
        INSERT INTO goal_checkpoints (id, goal_id, trigger, trigger_task_id, reason, tasks_snapshot, git_ref, change_summary, created_at)
        VALUES (@id, @goal_id, @trigger, @trigger_task_id, @reason, @tasks_snapshot, @git_ref, @change_summary, @created_at)
        ON CONFLICT(id) DO UPDATE SET
          trigger = excluded.trigger,
          trigger_task_id = excluded.trigger_task_id,
          reason = excluded.reason,
          tasks_snapshot = excluded.tasks_snapshot,
          git_ref = excluded.git_ref,
          change_summary = excluded.change_summary
      `),

      delete: db.prepare('DELETE FROM goal_checkpoints WHERE id = ?'),

      countByGoal: db.prepare(
        'SELECT COUNT(*) as cnt FROM goal_checkpoints WHERE goal_id = ?',
      ),

      getOldestByGoal: db.prepare(
        'SELECT id FROM goal_checkpoints WHERE goal_id = ? ORDER BY created_at ASC LIMIT ?',
      ),

      getFirstAndLastByGoal: db.prepare(`
        SELECT id FROM goal_checkpoints WHERE goal_id = ? AND (
          created_at = (SELECT MIN(created_at) FROM goal_checkpoints WHERE goal_id = ?1)
          OR created_at = (SELECT MAX(created_at) FROM goal_checkpoints WHERE goal_id = ?1)
        )
      `),

      deleteByGoalExcept: db.prepare(
        'DELETE FROM goal_checkpoints WHERE goal_id = ? AND id NOT IN (SELECT value FROM json_each(?))',
      ),
    };
  }

  // ==================== CRUD ====================

  async get(id: string): Promise<GoalCheckpoint | null> {
    const row = this.stmts.get.get(id) as GoalCheckpointRow | undefined;
    return row ? rowToCheckpoint(row) : null;
  }

  async getByGoal(goalId: string): Promise<GoalCheckpoint[]> {
    const rows = this.stmts.getByGoal.all(goalId) as GoalCheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  async save(checkpoint: GoalCheckpoint): Promise<void> {
    this.stmts.upsert.run({
      id: checkpoint.id,
      goal_id: checkpoint.goalId,
      trigger: checkpoint.trigger,
      trigger_task_id: checkpoint.triggerTaskId ?? null,
      reason: checkpoint.reason ?? null,
      tasks_snapshot: checkpoint.tasksSnapshot
        ? JSON.stringify(checkpoint.tasksSnapshot)
        : null,
      git_ref: checkpoint.gitRef ?? null,
      change_summary: checkpoint.changeSummary ?? null,
      created_at: checkpoint.createdAt,
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  // ==================== 业务方法 ====================

  /**
   * 保存快照并自动执行保留策略。
   *
   * 保留策略：每 Goal 最多 MAX_CHECKPOINTS_PER_GOAL 个，
   * 超出时自动删除最旧的快照。
   */
  async saveCheckpoint(checkpoint: GoalCheckpoint): Promise<void> {
    const saveAndCleanup = this.db.transaction(() => {
      // 1. 保存新快照
      this.stmts.upsert.run({
        id: checkpoint.id,
        goal_id: checkpoint.goalId,
        trigger: checkpoint.trigger,
        trigger_task_id: checkpoint.triggerTaskId ?? null,
        reason: checkpoint.reason ?? null,
        tasks_snapshot: checkpoint.tasksSnapshot
          ? JSON.stringify(checkpoint.tasksSnapshot)
          : null,
        git_ref: checkpoint.gitRef ?? null,
        change_summary: checkpoint.changeSummary ?? null,
        created_at: checkpoint.createdAt,
      });

      // 2. 检查是否超过上限
      const { cnt } = this.stmts.countByGoal.get(checkpoint.goalId) as { cnt: number };

      if (cnt > MAX_CHECKPOINTS_PER_GOAL) {
        // 找到需要删除的最旧快照
        const excess = cnt - MAX_CHECKPOINTS_PER_GOAL;
        const oldRows = this.stmts.getOldestByGoal.all(
          checkpoint.goalId,
          excess,
        ) as { id: string }[];

        for (const row of oldRows) {
          this.stmts.delete.run(row.id);
        }
      }
    });

    saveAndCleanup();
  }

  /**
   * 恢复指定快照，返回任务列表。
   * 如果快照不存在或没有 tasks_snapshot 则返回 null。
   */
  async restoreCheckpoint(checkpointId: string): Promise<GoalTask[] | null> {
    const row = this.stmts.get.get(checkpointId) as GoalCheckpointRow | undefined;
    if (!row || !row.tasks_snapshot) return null;
    return JSON.parse(row.tasks_snapshot) as GoalTask[];
  }

  /**
   * 列出指定 Goal 的所有快照（按时间倒序）。
   */
  async listByGoal(goalId: string): Promise<GoalCheckpoint[]> {
    return this.getByGoal(goalId);
  }

  /**
   * Goal 完成后压缩为只保留首末两个快照。
   *
   * @returns 删除的快照数量
   */
  async compressForCompletedGoal(goalId: string): Promise<number> {
    const compress = this.db.transaction(() => {
      // 找到首末两个快照的 ID
      const keepRows = this.stmts.getFirstAndLastByGoal.all(goalId, goalId) as { id: string }[];
      const keepIds = keepRows.map((r) => r.id);

      if (keepIds.length === 0) return 0;

      // 删除其余快照
      const result = this.stmts.deleteByGoalExcept.run(
        goalId,
        JSON.stringify(keepIds),
      );

      return result.changes;
    });

    return compress();
  }
}
