/**
 * Project SQLite Repository 实现
 *
 * 实现 IProjectRepo 接口，提供项目记录的 CRUD 操作。
 * 主键为项目文件夹名（与业务表 goals/ideas/devlogs/kb 的 project TEXT 字段一致）。
 */

import type Database from 'better-sqlite3';
import type { IProjectRepo, Project } from '../types/repository.js';
import type { ProjectRow } from '../types/db.js';

/** ProjectRow → Project */
function rowToProject(row: ProjectRow): Project {
  return {
    name: row.name,
    guildId: row.guild_id,
    categoryId: row.category_id,
    channelId: row.channel_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository implements IProjectRepo {
  private stmts: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare('SELECT * FROM projects WHERE name = ?'),
      getAll: db.prepare('SELECT * FROM projects ORDER BY name ASC'),
      // category_id / channel_id 用 COALESCE，避免 sync 时覆盖已有的 Discord 绑定
      upsert: db.prepare(`
        INSERT INTO projects (name, guild_id, category_id, channel_id, created_at, updated_at)
        VALUES (@name, @guild_id, @category_id, @channel_id, @created_at, @updated_at)
        ON CONFLICT(name) DO UPDATE SET
          guild_id    = COALESCE(excluded.guild_id, projects.guild_id),
          category_id = COALESCE(excluded.category_id, projects.category_id),
          channel_id  = COALESCE(excluded.channel_id, projects.channel_id),
          updated_at  = excluded.updated_at
      `),
      delete: db.prepare('DELETE FROM projects WHERE name = ?'),
    };
  }

  async get(name: string): Promise<Project | null> {
    const row = this.stmts.get.get(name) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  async getAll(): Promise<Project[]> {
    const rows = this.stmts.getAll.all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  async upsert(project: Project): Promise<void> {
    this.stmts.upsert.run({
      name: project.name,
      guild_id: project.guildId ?? null,
      category_id: project.categoryId ?? null,
      channel_id: project.channelId ?? null,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
    });
  }

  async delete(name: string): Promise<boolean> {
    const result = this.stmts.delete.run(name);
    return result.changes > 0;
  }
}
