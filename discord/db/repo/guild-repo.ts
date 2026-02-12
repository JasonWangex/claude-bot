/**
 * IGuildRepo 的 SQLite 实现
 *
 * 管理 Discord Guild 全局配置的 CRUD。
 * 主键: guild_id
 */

import type Database from 'better-sqlite3';
import type { IGuildRepo } from '../../types/repository.js';
import type { GuildState } from '../../types/index.js';
import type { GuildRow } from '../../types/db.js';

// ==================== 转换函数 ====================

function rowToGuildState(row: GuildRow): GuildState {
  return {
    guildId: row.guild_id,
    defaultCwd: row.default_cwd,
    defaultModel: row.default_model ?? undefined,
    lastActivity: row.last_activity,
  };
}

// ==================== Repository 实现 ====================

export class GuildRepository implements IGuildRepo {
  private stmts!: {
    get: Database.Statement;
    getAll: Database.Statement;
    upsert: Database.Statement;
    delete: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      get: this.db.prepare(`SELECT * FROM guilds WHERE guild_id = ?`),

      getAll: this.db.prepare(`SELECT * FROM guilds`),

      upsert: this.db.prepare(`
        INSERT INTO guilds (guild_id, default_cwd, default_model, last_activity)
        VALUES (@guild_id, @default_cwd, @default_model, @last_activity)
        ON CONFLICT(guild_id) DO UPDATE SET
          default_cwd = @default_cwd,
          default_model = @default_model,
          last_activity = @last_activity
      `),

      delete: this.db.prepare(`DELETE FROM guilds WHERE guild_id = ?`),
    };
  }

  async get(guildId: string): Promise<GuildState | null> {
    const row = this.stmts.get.get(guildId) as GuildRow | undefined;
    return row ? rowToGuildState(row) : null;
  }

  async save(guild: GuildState): Promise<void> {
    this.stmts.upsert.run({
      guild_id: guild.guildId,
      default_cwd: guild.defaultCwd,
      default_model: guild.defaultModel ?? null,
      last_activity: guild.lastActivity,
    });
  }

  async delete(guildId: string): Promise<boolean> {
    const result = this.stmts.delete.run(guildId);
    return result.changes > 0;
  }

  // ==================== 额外公开方法（StateManager 启动加载用） ====================

  /** 加载所有 guild 配置，用于启动时填充内存 Map */
  loadAll(): GuildState[] {
    const rows = this.stmts.getAll.all() as GuildRow[];
    return rows.map(rowToGuildState);
  }
}
