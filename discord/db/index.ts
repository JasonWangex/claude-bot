/**
 * SQLite 数据库初始化与管理
 *
 * 提供数据库连接的创建、migration 执行、以及全局单例管理。
 * 数据库文件默认存储在 data/bot.db。
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { runMigrations, getCurrentVersion } from './migrate.js';
import type { Migration } from './migrate.js';

// Migration 注册表 — 新增 migration 只需在此追加导入
import migration001 from './migrations/001_initial_schema.js';
import migration002 from './migrations/002_add_goal_checkpoints.js';
import migration003 from './migrations/003_add_pipeline_fields.js';
import migration004 from './migrations/004_add_goal_seq.js';
import migration005 from './migrations/005_drop_interaction_log.js';
import migration006 from './migrations/006_add_message_count.js';
import migration007 from './migrations/007_drop_message_history.js';
import migration008 from './migrations/008_add_knowledge_base.js';
import migration009 from './migrations/009_add_usage_columns.js';
import migration010 from './migrations/010_schema_restructure.js';
import migration011 from './migrations/011_add_prompt_configs.js';
import migration012 from './migrations/012_add_session_purpose.js';

const allMigrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '../../data/bot.db');

/** 全局数据库单例 */
let _db: Database.Database | null = null;

export interface InitDbOptions {
  /** 数据库文件路径，默认 data/bot.db */
  dbPath?: string;
  /** 启用 WAL 模式 (默认 true，生产推荐) */
  wal?: boolean;
  /** 是否输出日志 */
  verbose?: boolean;
}

/**
 * 初始化数据库连接并执行 migrations
 *
 * 只在首次调用时创建连接，后续调用返回同一实例。
 * 如果需要重新初始化（如测试），先调用 closeDb()。
 */
export function initDb(options: InitDbOptions = {}): Database.Database {
  if (_db) return _db;

  const {
    dbPath = process.env.DB_PATH || DEFAULT_DB_PATH,
    wal = true,
    verbose = false,
  } = options;

  // 确保数据目录存在
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const log = verbose ? console.log.bind(console) : () => {};

  log(`[DB] 打开数据库: ${dbPath}`);
  const db = new Database(dbPath);

  // SQLite 优化配置
  if (wal) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // 执行 migrations
  const versionBefore = getCurrentVersion(db);
  const applied = runMigrations(db, allMigrations);

  if (applied > 0) {
    log(`[DB] 已执行 ${applied} 个 migration (v${versionBefore} → v${getCurrentVersion(db)})`);
  } else {
    log(`[DB] 数据库已是最新版本 (v${versionBefore})`);
  }

  _db = db;
  return db;
}

/** 获取数据库实例（必须先调用 initDb） */
export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('数据库未初始化，请先调用 initDb()');
  }
  return _db;
}

/** 关闭数据库连接 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Re-export migration 工具
export { getCurrentVersion, runMigrations, rollbackTo } from './migrate.js';
export type { Migration } from './migrate.js';

// Re-export Repository 实现
export { DevLogRepository } from './devlog-repo.js';
export { IdeaRepository } from './idea-repo.js';
export { GoalMetaRepo } from './goal-meta-repo.js';
export { GoalRepo, TaskRepo, CheckpointRepo } from './repo/index.js';
/** @deprecated Use TaskRepo */
export { TaskRepo as GoalTaskRepo } from './repo/index.js';
export { SessionRepository, GuildRepository } from './repo/index.js';
export { ChannelRepository, ClaudeSessionRepository, SyncCursorRepository } from './repo/index.js';
export { KnowledgeBaseRepository } from './knowledge-base-repo.js';
export { PromptConfigRepository } from './prompt-config-repo.js';
