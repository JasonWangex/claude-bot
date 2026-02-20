/**
 * GoalTodo SQLite Repository 实现
 *
 * 管理 Goal 关联的待办事项 CRUD 和查询操作。
 */

import type Database from 'better-sqlite3';
import type { IGoalTodoRepo, GoalTodo } from '../types/repository.js';
import type { GoalTodoRow } from '../types/db.js';

/** GoalTodoRow → GoalTodo */
function rowToTodo(row: GoalTodoRow): GoalTodo {
  return {
    id: row.id,
    goalId: row.goal_id,
    content: row.content,
    done: row.done === 1,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GoalTodoRepository implements IGoalTodoRepo {
  private stmts: {
    get: Database.Statement;
    findByGoal: Database.Statement;
    findUndoneByGoal: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    deleteByGoal: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM goal_todos WHERE id = ?'),
      findByGoal: db.prepare('SELECT * FROM goal_todos WHERE goal_id = ? ORDER BY created_at ASC'),
      findUndoneByGoal: db.prepare('SELECT * FROM goal_todos WHERE goal_id = ? AND done = 0 ORDER BY created_at ASC'),
      upsert: db.prepare(`
        INSERT INTO goal_todos (id, goal_id, content, done, source, created_at, updated_at)
        VALUES (@id, @goal_id, @content, @done, @source, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          done = excluded.done,
          source = excluded.source,
          updated_at = excluded.updated_at
      `),
      delete: db.prepare('DELETE FROM goal_todos WHERE id = ?'),
      deleteByGoal: db.prepare('DELETE FROM goal_todos WHERE goal_id = ?'),
    };
  }

  async get(id: string): Promise<GoalTodo | null> {
    const row = this.stmts.get.get(id) as GoalTodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }

  async findByGoal(goalId: string): Promise<GoalTodo[]> {
    const rows = this.stmts.findByGoal.all(goalId) as GoalTodoRow[];
    return rows.map(rowToTodo);
  }

  async findUndoneByGoal(goalId: string): Promise<GoalTodo[]> {
    const rows = this.stmts.findUndoneByGoal.all(goalId) as GoalTodoRow[];
    return rows.map(rowToTodo);
  }

  async save(todo: GoalTodo): Promise<void> {
    this.stmts.upsert.run({
      id: todo.id,
      goal_id: todo.goalId,
      content: todo.content,
      done: todo.done ? 1 : 0,
      source: todo.source,
      created_at: todo.createdAt,
      updated_at: todo.updatedAt,
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.stmts.delete.run(id).changes > 0;
  }

  async deleteByGoal(goalId: string): Promise<number> {
    return this.stmts.deleteByGoal.run(goalId).changes;
  }
}
