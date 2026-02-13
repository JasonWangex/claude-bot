/**
 * KnowledgeBase SQLite Repository 实现
 *
 * 实现 IKnowledgeBaseRepo 接口，提供知识库条目的 CRUD 和查询操作。
 */

import type Database from 'better-sqlite3';
import type { IKnowledgeBaseRepo, KnowledgeBase } from '../types/repository.js';
import type { KnowledgeBaseRow } from '../types/db.js';

/** KnowledgeBaseRow → KnowledgeBase */
function rowToKB(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags ? JSON.parse(row.tags) : [],
    project: row.project,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class KnowledgeBaseRepository implements IKnowledgeBaseRepo {
  private stmts: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    findByProject: Database.Statement;
    findByCategory: Database.Statement;
    search: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM knowledge_base WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM knowledge_base ORDER BY updated_at DESC'),
      upsert: db.prepare(`
        INSERT INTO knowledge_base (id, title, content, category, tags, project, source, created_at, updated_at)
        VALUES (@id, @title, @content, @category, @tags, @project, @source, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          category = excluded.category,
          tags = excluded.tags,
          project = excluded.project,
          source = excluded.source,
          updated_at = excluded.updated_at
      `),
      delete: db.prepare('DELETE FROM knowledge_base WHERE id = ?'),
      findByProject: db.prepare('SELECT * FROM knowledge_base WHERE project = ? ORDER BY updated_at DESC'),
      findByCategory: db.prepare('SELECT * FROM knowledge_base WHERE category = ? ORDER BY updated_at DESC'),
      search: db.prepare('SELECT * FROM knowledge_base WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC'),
    };
  }

  async get(id: string): Promise<KnowledgeBase | null> {
    const row = this.stmts.get.get(id) as KnowledgeBaseRow | undefined;
    return row ? rowToKB(row) : null;
  }

  async getAll(): Promise<KnowledgeBase[]> {
    const rows = this.stmts.getAll.all() as KnowledgeBaseRow[];
    return rows.map(rowToKB);
  }

  async save(kb: KnowledgeBase): Promise<void> {
    this.stmts.upsert.run({
      id: kb.id,
      title: kb.title,
      content: kb.content,
      category: kb.category,
      tags: kb.tags.length > 0 ? JSON.stringify(kb.tags) : null,
      project: kb.project,
      source: kb.source,
      created_at: kb.createdAt,
      updated_at: kb.updatedAt,
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async findByProject(project: string): Promise<KnowledgeBase[]> {
    const rows = this.stmts.findByProject.all(project) as KnowledgeBaseRow[];
    return rows.map(rowToKB);
  }

  async findByCategory(category: string): Promise<KnowledgeBase[]> {
    const rows = this.stmts.findByCategory.all(category) as KnowledgeBaseRow[];
    return rows.map(rowToKB);
  }

  async search(query: string): Promise<KnowledgeBase[]> {
    const pattern = `%${query}%`;
    const rows = this.stmts.search.all(pattern, pattern) as KnowledgeBaseRow[];
    return rows.map(rowToKB);
  }
}
