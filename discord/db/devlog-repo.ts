/**
 * DevLog SQLite Repository 实现
 *
 * 实现 IDevLogRepo 接口，提供开发日志的 CRUD 和查询操作。
 */

import type Database from 'better-sqlite3';
import type { IDevLogRepo, DevLog } from '../types/repository.js';
import type { DevLogRow } from '../types/db.js';

/** DevLogRow → DevLog */
function rowToDevLog(row: DevLogRow): DevLog {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    project: row.project,
    branch: row.branch ?? '',
    summary: row.summary ?? '',
    commits: row.commits ?? 0,
    linesChanged: row.lines_changed ?? '',
    goal: row.goal ?? undefined,
    content: row.body ?? undefined,
    createdAt: row.created_at,
  };
}

export class DevLogRepository implements IDevLogRepo {
  private stmts: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    findByProject: Database.Statement;
    findByDateRange: Database.Statement;
    findByGoal: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM devlogs WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM devlogs ORDER BY date DESC, created_at DESC'),
      upsert: db.prepare(`
        INSERT INTO devlogs (id, name, date, project, branch, summary, commits, lines_changed, goal, body, created_at)
        VALUES (@id, @name, @date, @project, @branch, @summary, @commits, @lines_changed, @goal, @body, @created_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          date = excluded.date,
          project = excluded.project,
          branch = excluded.branch,
          summary = excluded.summary,
          commits = excluded.commits,
          lines_changed = excluded.lines_changed,
          goal = excluded.goal,
          body = excluded.body
      `),
      delete: db.prepare('DELETE FROM devlogs WHERE id = ?'),
      findByProject: db.prepare('SELECT * FROM devlogs WHERE project = ? ORDER BY date DESC, created_at DESC'),
      findByDateRange: db.prepare('SELECT * FROM devlogs WHERE date >= ? AND date <= ? ORDER BY date DESC, created_at DESC'),
      findByGoal: db.prepare('SELECT * FROM devlogs WHERE goal = ? ORDER BY date DESC, created_at DESC'),
    };
  }

  async get(id: string): Promise<DevLog | null> {
    const row = this.stmts.get.get(id) as DevLogRow | undefined;
    return row ? rowToDevLog(row) : null;
  }

  async getAll(): Promise<DevLog[]> {
    const rows = this.stmts.getAll.all() as DevLogRow[];
    return rows.map(rowToDevLog);
  }

  async save(log: DevLog): Promise<void> {
    this.stmts.upsert.run({
      id: log.id,
      name: log.name,
      date: log.date,
      project: log.project,
      branch: log.branch ?? null,
      summary: log.summary ?? null,
      commits: log.commits ?? null,
      lines_changed: log.linesChanged ?? null,
      goal: log.goal ?? null,
      body: log.content ?? null,
      created_at: log.createdAt,
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async findByProject(project: string): Promise<DevLog[]> {
    const rows = this.stmts.findByProject.all(project) as DevLogRow[];
    return rows.map(rowToDevLog);
  }

  async findByDateRange(start: string, end: string): Promise<DevLog[]> {
    const rows = this.stmts.findByDateRange.all(start, end) as DevLogRow[];
    return rows.map(rowToDevLog);
  }

  async findByGoal(goal: string): Promise<DevLog[]> {
    const rows = this.stmts.findByGoal.all(goal) as DevLogRow[];
    return rows.map(rowToDevLog);
  }
}
