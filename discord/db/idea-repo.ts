/**
 * Idea SQLite Repository 实现
 *
 * 实现 IIdeaRepo 接口，提供想法记录的 CRUD 和查询操作。
 */

import type Database from 'better-sqlite3';
import type { IIdeaRepo, Idea, IdeaStatus } from '../types/repository.js';
import type { IdeaRow } from '../types/db.js';

/** IdeaRow → Idea */
function rowToIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    name: row.name,
    status: row.status as IdeaStatus,
    project: row.project,
    date: row.date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IdeaRepository implements IIdeaRepo {
  private stmts: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    findByStatus: Database.Statement;
    findByProject: Database.Statement;
    findByProjectAndStatus: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM ideas WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM ideas ORDER BY updated_at DESC'),
      upsert: db.prepare(`
        INSERT INTO ideas (id, name, status, project, date, created_at, updated_at)
        VALUES (@id, @name, @status, @project, @date, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          status = excluded.status,
          project = excluded.project,
          date = excluded.date,
          updated_at = excluded.updated_at
      `),
      delete: db.prepare('DELETE FROM ideas WHERE id = ?'),
      findByStatus: db.prepare('SELECT * FROM ideas WHERE status = ? ORDER BY updated_at DESC'),
      findByProject: db.prepare('SELECT * FROM ideas WHERE project = ? ORDER BY updated_at DESC'),
      findByProjectAndStatus: db.prepare('SELECT * FROM ideas WHERE project = ? AND status = ? ORDER BY updated_at DESC'),
    };
  }

  async get(id: string): Promise<Idea | null> {
    const row = this.stmts.get.get(id) as IdeaRow | undefined;
    return row ? rowToIdea(row) : null;
  }

  async getAll(): Promise<Idea[]> {
    const rows = this.stmts.getAll.all() as IdeaRow[];
    return rows.map(rowToIdea);
  }

  async save(idea: Idea): Promise<void> {
    this.stmts.upsert.run({
      id: idea.id,
      name: idea.name,
      status: idea.status,
      project: idea.project,
      date: idea.date,
      created_at: idea.createdAt,
      updated_at: idea.updatedAt,
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async findByStatus(status: IdeaStatus): Promise<Idea[]> {
    const rows = this.stmts.findByStatus.all(status) as IdeaRow[];
    return rows.map(rowToIdea);
  }

  async findByProject(project: string): Promise<Idea[]> {
    const rows = this.stmts.findByProject.all(project) as IdeaRow[];
    return rows.map(rowToIdea);
  }

  async findByProjectAndStatus(project: string, status: IdeaStatus): Promise<Idea[]> {
    const rows = this.stmts.findByProjectAndStatus.all(project, status) as IdeaRow[];
    return rows.map(rowToIdea);
  }
}
