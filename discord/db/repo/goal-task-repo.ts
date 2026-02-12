/**
 * IGoalTaskRepo 的 SQLite 实现
 *
 * 管理 Goal 下子任务的 CRUD 和查询。
 * 复合主键: (goal_id, id)
 * 依赖关系通过 goal_task_deps 表管理。
 */

import type Database from 'better-sqlite3';
import type { IGoalTaskRepo } from '../../types/repository.js';
import type { GoalTask, GoalTaskStatus } from '../../types/index.js';
import type { GoalTaskRow, GoalTaskDepRow } from '../../types/db.js';

export class GoalTaskRepo implements IGoalTaskRepo {
  private db: Database.Database;

  private stmts!: {
    getTask: Database.Statement;
    getTasksByGoal: Database.Statement;
    upsertTask: Database.Statement;
    deleteTask: Database.Statement;
    deleteAllByGoal: Database.Statement;
    findByStatus: Database.Statement;
    findByThreadId: Database.Statement;
    getDepsByTask: Database.Statement;
    getDepsByGoal: Database.Statement;
    deleteDeps: Database.Statement;
    deleteDepsByGoal: Database.Statement;
    insertDep: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      getTask: this.db.prepare(
        `SELECT * FROM goal_tasks WHERE goal_id = ? AND id = ?`,
      ),

      getTasksByGoal: this.db.prepare(
        `SELECT * FROM goal_tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
      ),

      upsertTask: this.db.prepare(`
        INSERT INTO goal_tasks (
          id, goal_id, description, type, phase, status,
          branch_name, thread_id, dispatched_at, completed_at,
          error, merged, notified_blocked
        ) VALUES (
          @id, @goal_id, @description, @type, @phase, @status,
          @branch_name, @thread_id, @dispatched_at, @completed_at,
          @error, @merged, @notified_blocked
        )
        ON CONFLICT(goal_id, id) DO UPDATE SET
          description = @description,
          type = @type,
          phase = @phase,
          status = @status,
          branch_name = @branch_name,
          thread_id = @thread_id,
          dispatched_at = @dispatched_at,
          completed_at = @completed_at,
          error = @error,
          merged = @merged,
          notified_blocked = @notified_blocked
      `),

      deleteTask: this.db.prepare(
        `DELETE FROM goal_tasks WHERE goal_id = ? AND id = ?`,
      ),

      deleteAllByGoal: this.db.prepare(
        `DELETE FROM goal_tasks WHERE goal_id = ?`,
      ),

      findByStatus: this.db.prepare(
        `SELECT * FROM goal_tasks WHERE goal_id = ? AND status = ? ORDER BY phase ASC, id ASC`,
      ),

      findByThreadId: this.db.prepare(
        `SELECT * FROM goal_tasks WHERE thread_id = ?`,
      ),

      getDepsByTask: this.db.prepare(
        `SELECT * FROM goal_task_deps WHERE goal_id = ? AND task_id = ?`,
      ),

      getDepsByGoal: this.db.prepare(
        `SELECT * FROM goal_task_deps WHERE goal_id = ?`,
      ),

      deleteDeps: this.db.prepare(
        `DELETE FROM goal_task_deps WHERE goal_id = ? AND task_id = ?`,
      ),

      deleteDepsByGoal: this.db.prepare(
        `DELETE FROM goal_task_deps WHERE goal_id = ?`,
      ),

      insertDep: this.db.prepare(
        `INSERT OR IGNORE INTO goal_task_deps (goal_id, task_id, depends_on_task_id) VALUES (?, ?, ?)`,
      ),
    };
  }

  async get(goalId: string, taskId: string): Promise<GoalTask | null> {
    const row = this.stmts.getTask.get(goalId, taskId) as GoalTaskRow | undefined;
    if (!row) return null;

    const depRows = this.stmts.getDepsByTask.all(goalId, taskId) as GoalTaskDepRow[];
    return taskRowToGoalTask(row, depRows);
  }

  async getAllByGoal(goalId: string): Promise<GoalTask[]> {
    const rows = this.stmts.getTasksByGoal.all(goalId) as GoalTaskRow[];
    const depRows = this.stmts.getDepsByGoal.all(goalId) as GoalTaskDepRow[];

    // 建立 taskId → deps 映射
    const depsMap = buildDepsMap(depRows);

    return rows.map((row) => taskRowToGoalTask(row, depsMap.get(row.id)));
  }

  async save(goalId: string, task: GoalTask): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      this.stmts.upsertTask.run(goalTaskToRow(goalId, task));

      // 替换依赖关系
      this.stmts.deleteDeps.run(goalId, task.id);
      for (const dep of task.depends) {
        this.stmts.insertDep.run(goalId, task.id, dep);
      }
    });

    saveTransaction();
  }

  async saveAll(goalId: string, tasks: GoalTask[]): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      // 先清除该 goal 下所有依赖
      this.stmts.deleteDepsByGoal.run(goalId);
      // 清除所有任务
      this.stmts.deleteAllByGoal.run(goalId);

      // 重新插入
      for (const task of tasks) {
        this.stmts.upsertTask.run(goalTaskToRow(goalId, task));
        for (const dep of task.depends) {
          this.stmts.insertDep.run(goalId, task.id, dep);
        }
      }
    });

    saveTransaction();
  }

  async delete(goalId: string, taskId: string): Promise<boolean> {
    // CASCADE 会自动删除 goal_task_deps
    const result = this.stmts.deleteTask.run(goalId, taskId);
    return result.changes > 0;
  }

  async deleteAllByGoal(goalId: string): Promise<void> {
    // CASCADE 会自动删除 goal_task_deps
    this.stmts.deleteAllByGoal.run(goalId);
  }

  async findByStatus(goalId: string, status: GoalTaskStatus): Promise<GoalTask[]> {
    const rows = this.stmts.findByStatus.all(goalId, status) as GoalTaskRow[];
    const depRows = this.stmts.getDepsByGoal.all(goalId) as GoalTaskDepRow[];
    const depsMap = buildDepsMap(depRows);

    return rows.map((row) => taskRowToGoalTask(row, depsMap.get(row.id)));
  }

  async findByThreadId(threadId: string): Promise<{ goalId: string; task: GoalTask } | null> {
    const row = this.stmts.findByThreadId.get(threadId) as GoalTaskRow | undefined;
    if (!row) return null;

    const depRows = this.stmts.getDepsByTask.all(row.goal_id, row.id) as GoalTaskDepRow[];
    return {
      goalId: row.goal_id,
      task: taskRowToGoalTask(row, depRows),
    };
  }
}

// ==================== 转换函数 ====================

function goalTaskToRow(goalId: string, task: GoalTask): Record<string, unknown> {
  return {
    id: task.id,
    goal_id: goalId,
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
  };
}

function taskRowToGoalTask(
  row: GoalTaskRow,
  deps?: GoalTaskDepRow[] | string[],
): GoalTask {
  // deps 可能是 GoalTaskDepRow[] 或已经从 map 拿到的 string[]
  let dependsList: string[];
  if (!deps || deps.length === 0) {
    dependsList = [];
  } else if (typeof deps[0] === 'string') {
    dependsList = deps as string[];
  } else {
    dependsList = (deps as GoalTaskDepRow[]).map((d) => d.depends_on_task_id);
  }

  return {
    id: row.id,
    description: row.description,
    type: row.type,
    depends: dependsList,
    phase: row.phase ?? undefined,
    status: row.status,
    branchName: row.branch_name ?? undefined,
    threadId: row.thread_id ?? undefined,
    dispatchedAt: row.dispatched_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    merged: row.merged === 1 ? true : undefined,
    notifiedBlocked: row.notified_blocked === 1 ? true : undefined,
  };
}

/** 从 deps 行列表构建 taskId → depends_on_task_id[] 映射 */
function buildDepsMap(depRows: GoalTaskDepRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const dep of depRows) {
    const list = map.get(dep.task_id) || [];
    list.push(dep.depends_on_task_id);
    map.set(dep.task_id, list);
  }
  return map;
}
