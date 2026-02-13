/**
 * 测试辅助：创建 in-memory SQLite 数据库并执行 schema migration
 */

import Database from 'better-sqlite3';
import migration001 from '../../migrations/001_initial_schema.js';
import migration002 from '../../migrations/002_add_goal_checkpoints.js';
import migration003 from '../../migrations/003_add_pipeline_fields.js';
import migration004 from '../../migrations/004_add_goal_seq.js';
import migration005 from '../../migrations/005_add_interaction_log.js';
import migration006 from '../../migrations/006_add_message_count.js';
import migration007 from '../../migrations/007_drop_message_history.js';
import { runMigrations } from '../../migrate.js';

const allMigrations = [migration001, migration002, migration003, migration004, migration005, migration006, migration007];

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, allMigrations);
  return db;
}
