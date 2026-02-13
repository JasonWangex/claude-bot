/**
 * Goal 元数据 SQLite Repository 实现
 *
 * 管理 Goal 的完整元数据（name, status, body 等）。
 * 与 GoalRepo（仅管理 Drive 状态）互补。
 */

import type Database from 'better-sqlite3';
import type { IGoalMetaRepo, Goal, GoalStatus, GoalType } from '../types/repository.js';
import type { GoalRow } from '../types/db.js';

/** GoalRow → Goal */
function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    status: row.status as GoalStatus,
    type: (row.type as GoalType) ?? null,
    project: row.project,
    date: row.date,
    completion: row.completion,
    progress: row.progress,
    next: row.next,
    blockedBy: row.blocked_by,
    body: row.body,
    seq: row.seq ?? null,
  };
}

export class GoalMetaRepo implements IGoalMetaRepo {
  private stmts: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    findByStatus: Database.Statement;
    findByProject: Database.Statement;
    search: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM goals WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM goals ORDER BY date DESC'),
      upsert: db.prepare(`
        INSERT INTO goals (id, name, status, type, project, date, completion, progress, next, blocked_by, body, seq)
        VALUES (@id, @name, @status, @type, @project, @date, @completion, @progress, @next, @blocked_by, @body,
                COALESCE(@seq, (SELECT COALESCE(MAX(seq), 0) + 1 FROM goals)))
        ON CONFLICT(id) DO UPDATE SET
          name = @name,
          status = @status,
          type = @type,
          project = @project,
          date = @date,
          completion = @completion,
          progress = @progress,
          next = @next,
          blocked_by = @blocked_by,
          body = @body
      `),
      delete: db.prepare('DELETE FROM goals WHERE id = ?'),
      findByStatus: db.prepare('SELECT * FROM goals WHERE status = ? ORDER BY date DESC'),
      findByProject: db.prepare('SELECT * FROM goals WHERE project = ? ORDER BY date DESC'),
      search: db.prepare('SELECT * FROM goals WHERE name LIKE ? OR body LIKE ? ORDER BY date DESC'),
    };
  }

  async get(id: string): Promise<Goal | null> {
    const row = this.stmts.get.get(id) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  async getAll(): Promise<Goal[]> {
    const rows = this.stmts.getAll.all() as GoalRow[];
    return rows.map(rowToGoal);
  }

  async save(goal: Goal): Promise<void> {
    this.stmts.upsert.run({
      id: goal.id,
      name: goal.name,
      status: goal.status,
      type: goal.type,
      project: goal.project,
      date: goal.date,
      completion: goal.completion,
      progress: goal.progress,
      next: goal.next,
      blocked_by: goal.blockedBy,
      body: goal.body,
      seq: goal.seq,
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async findByStatus(status: GoalStatus): Promise<Goal[]> {
    const rows = this.stmts.findByStatus.all(status) as GoalRow[];
    return rows.map(rowToGoal);
  }

  async findByProject(project: string): Promise<Goal[]> {
    const rows = this.stmts.findByProject.all(project) as GoalRow[];
    return rows.map(rowToGoal);
  }

  async search(query: string): Promise<Goal[]> {
    const pattern = `%${query}%`;
    const rows = this.stmts.search.all(pattern, pattern) as GoalRow[];
    return rows.map(rowToGoal);
  }
}
