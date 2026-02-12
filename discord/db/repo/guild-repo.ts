/**
 * SQLite GuildRepo 实现
 *
 * 实现 IGuildRepo 接口，管理 guilds 表。
 */

import type Database from 'better-sqlite3';
import type { IGuildRepo } from '../../types/repository.js';
import type { GuildState } from '../../types/index.js';
import type { GuildRow } from '../../types/db.js';

// ==================== Row ↔ Domain 转换 ====================

function guildToRow(g: GuildState): GuildRow {
  return {
    guild_id: g.guildId,
    default_cwd: g.defaultCwd,
    default_model: g.defaultModel ?? null,
    last_activity: g.lastActivity,
  };
}

function rowToGuild(row: GuildRow): GuildState {
  return {
    guildId: row.guild_id,
    defaultCwd: row.default_cwd,
    defaultModel: row.default_model ?? undefined,
    lastActivity: row.last_activity,
  };
}

// ==================== GuildRepo ====================

export class GuildRepo implements IGuildRepo {
  private db: Database.Database;

  private _stmts?: ReturnType<GuildRepo['prepareStatements']>;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private get stmts() {
    if (!this._stmts) {
      this._stmts = this.prepareStatements();
    }
    return this._stmts;
  }

  private prepareStatements() {
    return {
      getById: this.db.prepare<[string]>(
        `SELECT * FROM guilds WHERE guild_id = ?`
      ),
      upsert: this.db.prepare(`
        INSERT INTO guilds (guild_id, default_cwd, default_model, last_activity)
        VALUES (@guild_id, @default_cwd, @default_model, @last_activity)
        ON CONFLICT(guild_id) DO UPDATE SET
          default_cwd = excluded.default_cwd,
          default_model = excluded.default_model,
          last_activity = excluded.last_activity
      `),
      deleteById: this.db.prepare<[string]>(
        `DELETE FROM guilds WHERE guild_id = ?`
      ),
    };
  }

  async get(guildId: string): Promise<GuildState | null> {
    const row = this.stmts.getById.get(guildId) as GuildRow | undefined;
    if (!row) return null;
    return rowToGuild(row);
  }

  async save(guild: GuildState): Promise<void> {
    const row = guildToRow(guild);
    this.stmts.upsert.run(row);
  }

  async delete(guildId: string): Promise<boolean> {
    const result = this.stmts.deleteById.run(guildId);
    return result.changes > 0;
  }
}
