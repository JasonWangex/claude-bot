/**
 * SQLite Migration 机制
 *
 * 使用 user_version PRAGMA 跟踪当前数据库版本。
 * migration 文件按版本号顺序执行，每个 migration 在事务中运行。
 */

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

/** 获取当前数据库版本 */
export function getCurrentVersion(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true });
  return row as number;
}

/** 设置数据库版本 */
function setVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}

/**
 * 执行所有待应用的 migration
 *
 * @returns 实际执行的 migration 数量
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): number {
  // 按版本号排序
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // 校验版本号连续性
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].version !== i + 1) {
      throw new Error(
        `Migration 版本号不连续: 期望 ${i + 1}，得到 ${sorted[i].version} (${sorted[i].name})`
      );
    }
  }

  const currentVersion = getCurrentVersion(db);
  const pending = sorted.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    return 0;
  }

  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      setVersion(db, migration.version);
    });
    run();
  }

  return pending.length;
}

/**
 * 回滚到指定版本（仅供开发/调试使用）
 *
 * @param targetVersion 回滚到的目标版本号 (0 = 全部回滚)
 * @returns 实际回滚的 migration 数量
 */
export function rollbackTo(
  db: Database.Database,
  migrations: Migration[],
  targetVersion: number,
): number {
  const sorted = [...migrations].sort((a, b) => b.version - a.version); // 降序
  const currentVersion = getCurrentVersion(db);

  if (targetVersion >= currentVersion) {
    return 0;
  }

  const toRollback = sorted.filter(
    m => m.version <= currentVersion && m.version > targetVersion,
  );

  for (const migration of toRollback) {
    const run = db.transaction(() => {
      migration.down(db);
      setVersion(db, migration.version - 1);
    });
    run();
  }

  return toRollback.length;
}
