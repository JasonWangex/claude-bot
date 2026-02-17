/**
 * 测试辅助：创建 in-memory SQLite 数据库并执行 schema migration
 */

import Database from 'better-sqlite3';
import migration001 from '../../migrations/001_create_schema.js';
import { runMigrations } from '../../migrate.js';

const allMigrations = [migration001];

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, allMigrations);
  return db;
}
