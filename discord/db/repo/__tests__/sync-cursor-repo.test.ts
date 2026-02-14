import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SyncCursorRepository } from '../sync-cursor-repo.js';
import { createTestDb } from './test-helpers.js';

describe('SyncCursorRepository', () => {
  let db: Database.Database;
  let repo: SyncCursorRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SyncCursorRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==================== get & set ====================

  describe('get & set', () => {
    it('should set and get a cursor', async () => {
      await repo.set('source-1', 'cursor-value-1');

      const result = await repo.get('source-1');
      expect(result).toBe('cursor-value-1');
    });

    it('should return null for non-existent source', async () => {
      const result = await repo.get('source-999');
      expect(result).toBeNull();
    });

    it('should upsert on conflict (same source)', async () => {
      await repo.set('source-1', 'cursor-v1');
      await repo.set('source-1', 'cursor-v2');

      const result = await repo.get('source-1');
      expect(result).toBe('cursor-v2');
    });

    it('should handle multiple sources independently', async () => {
      await repo.set('source-1', 'cursor-1');
      await repo.set('source-2', 'cursor-2');
      await repo.set('source-3', 'cursor-3');

      expect(await repo.get('source-1')).toBe('cursor-1');
      expect(await repo.get('source-2')).toBe('cursor-2');
      expect(await repo.get('source-3')).toBe('cursor-3');
    });
  });

  // ==================== delete ====================

  describe('delete', () => {
    it('should delete a cursor', async () => {
      await repo.set('source-1', 'cursor-1');

      const deleted = await repo.delete('source-1');
      expect(deleted).toBe(true);

      const result = await repo.get('source-1');
      expect(result).toBeNull();
    });

    it('should return false if source does not exist', async () => {
      const deleted = await repo.delete('source-999');
      expect(deleted).toBe(false);
    });
  });

  // ==================== loadAll ====================

  describe('loadAll', () => {
    it('should load all cursors as a Map', () => {
      repo.set('source-1', 'cursor-1');
      repo.set('source-2', 'cursor-2');
      repo.set('source-3', 'cursor-3');

      const map = repo.loadAll();
      // Note: migration 010 inserts 'schema_migration_010', so we expect 4 entries
      expect(map.size).toBe(4);
      expect(map.get('source-1')).toBe('cursor-1');
      expect(map.get('source-2')).toBe('cursor-2');
      expect(map.get('source-3')).toBe('cursor-3');
      expect(map.get('schema_migration_010')).toBe('completed');
    });

    it('should return Map with migration cursor if no other cursors exist', () => {
      const map = repo.loadAll();
      // Migration 010 automatically inserts 'schema_migration_010'
      expect(map.size).toBe(1);
      expect(map.get('schema_migration_010')).toBe('completed');
    });
  });
});
