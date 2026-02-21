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
import migration001 from './migrations/001_create_schema.js';
import migration002 from './migrations/002_add_session_title.js';
import migration003 from './migrations/003_add_session_context.js';
import migration004 from './migrations/004_add_session_project_path.js';
import migration005 from './migrations/005_unique_claude_session_id.js';
import migration006 from './migrations/006_channel_session_links.js';
import migration007 from './migrations/007_session_pk_refactor.js';
import migration008 from './migrations/008_drop_deprecated_sessions.js';
import migration009 from './migrations/009_add_brain_channel.js';
import migration010 from './migrations/010_add_task_detail_plan.js';
import migration011 from './migrations/011_update_prompts.js';
import migration012 from './migrations/012_remove_skill_prompts.js';
import migration013 from './migrations/013_add_session_usage.js';
import migration014 from './migrations/014_create_goal_todos.js';
import migration015 from './migrations/015_add_model_usage.js';
import migration016 from './migrations/016_create_task_events.js';
import migration017 from './migrations/017_cleanup_old_prompts.js';
import migration018 from './migrations/018_add_missing_orchestrator_prompts.js';
import migration019 from './migrations/019_drop_task_deps.js';
import migration020 from './migrations/020_cleanup_task_dep_prompt.js';
import migration021 from './migrations/021_cleanup_orphan_prompts.js';
import migration022 from './migrations/022_add_reviewer_prompts.js';
import migration023 from './migrations/023_add_conflict_review_prompt.js';
import migration024 from './migrations/024_update_task_prompts_to_event_protocol.js';
import migration025 from './migrations/025_update_replan_prompt_to_event_protocol.js';
import migration026 from './migrations/026_add_todo_priority.js';
import migration027 from './migrations/027_remove_conflict_resolver.js';
import migration028 from './migrations/028_update_reviewer_init_prompt.js';
import migration029 from './migrations/029_fix_replan_task_id_format.js';
import migration030 from './migrations/030_update_task_review_prompt.js';
import migration031 from './migrations/031_add_hidden_session.js';
import migration032 from './migrations/032_create_goal_timeline.js';

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
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
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
export { GuildRepository } from './repo/index.js';
export { ChannelRepository, ClaudeSessionRepository, ChannelSessionLinkRepository, SyncCursorRepository } from './repo/index.js';
export type { ChannelSessionLink } from './repo/index.js';
export { KnowledgeBaseRepository } from './knowledge-base-repo.js';
export { PromptConfigRepository } from './prompt-config-repo.js';
export { GoalTodoRepository } from './goal-todo-repo.js';
export { TaskEventRepo, EVENT_TYPES } from './repo/task-event-repo.js';
export type { EventType, PendingEvent } from './repo/task-event-repo.js';
export { GoalTimelineRepo } from './repo/goal-timeline-repo.js';
export type { GoalTimelineEvent, TimelineEventType } from './repo/goal-timeline-repo.js';
