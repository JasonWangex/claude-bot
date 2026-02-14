/**
 * PromptConfig SQLite Repository 实现
 *
 * 管理 prompt 模板的 CRUD 和查询操作。
 */

import type Database from 'better-sqlite3';
import type { IPromptConfigRepo, PromptConfig } from '../types/repository.js';
import type { PromptConfigRow } from '../types/db.js';

/** PromptConfigRow → PromptConfig */
function rowToConfig(row: PromptConfigRow): PromptConfig {
  return {
    key: row.key,
    category: row.category,
    name: row.name,
    description: row.description,
    template: row.template,
    variables: row.variables ? JSON.parse(row.variables) : [],
    parentKey: row.parent_key,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PromptConfigRepository implements IPromptConfigRepo {
  private stmts: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
    findByCategory: Database.Statement;
    findChildren: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM prompt_configs WHERE key = ?'),
      getAll: db.prepare('SELECT * FROM prompt_configs ORDER BY category, key'),
      upsert: db.prepare(`
        INSERT INTO prompt_configs (key, category, name, description, template, variables, parent_key, sort_order, created_at, updated_at)
        VALUES (@key, @category, @name, @description, @template, @variables, @parent_key, @sort_order, @created_at, @updated_at)
        ON CONFLICT(key) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          template = excluded.template,
          variables = excluded.variables,
          parent_key = excluded.parent_key,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `),
      delete: db.prepare('DELETE FROM prompt_configs WHERE key = ?'),
      findByCategory: db.prepare('SELECT * FROM prompt_configs WHERE category = ? ORDER BY key'),
      findChildren: db.prepare('SELECT * FROM prompt_configs WHERE parent_key = ? ORDER BY sort_order'),
    };
  }

  async get(key: string): Promise<PromptConfig | null> {
    const row = this.stmts.get.get(key) as PromptConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  async getAll(): Promise<PromptConfig[]> {
    const rows = this.stmts.getAll.all() as PromptConfigRow[];
    return rows.map(rowToConfig);
  }

  async save(config: PromptConfig): Promise<void> {
    this.stmts.upsert.run({
      key: config.key,
      category: config.category,
      name: config.name,
      description: config.description,
      template: config.template,
      variables: JSON.stringify(config.variables),
      parent_key: config.parentKey,
      sort_order: config.sortOrder,
      created_at: config.createdAt,
      updated_at: config.updatedAt,
    });
  }

  async delete(key: string): Promise<boolean> {
    const result = this.stmts.delete.run(key);
    return result.changes > 0;
  }

  async findByCategory(category: 'skill' | 'orchestrator'): Promise<PromptConfig[]> {
    const rows = this.stmts.findByCategory.all(category) as PromptConfigRow[];
    return rows.map(rowToConfig);
  }

  async findChildren(parentKey: string): Promise<PromptConfig[]> {
    const rows = this.stmts.findChildren.all(parentKey) as PromptConfigRow[];
    return rows.map(rowToConfig);
  }
}
