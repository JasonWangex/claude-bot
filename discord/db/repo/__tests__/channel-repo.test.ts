import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ChannelRepository } from '../channel-repo.js';
import { createTestDb } from './test-helpers.js';
import type { Channel } from '../../../types/index.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'channel-1',
    guildId: 'guild-1',
    name: 'Test Channel',
    cwd: '/home/test',
    status: 'active',
    messageCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('ChannelRepository', () => {
  let db: Database.Database;
  let repo: ChannelRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ChannelRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==================== CRUD ====================

  describe('save & get', () => {
    it('should save and retrieve a channel', async () => {
      const channel = makeChannel();
      await repo.save(channel);

      const result = await repo.get('channel-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('channel-1');
      expect(result!.guildId).toBe('guild-1');
      expect(result!.name).toBe('Test Channel');
      expect(result!.cwd).toBe('/home/test');
      expect(result!.status).toBe('active');
    });

    it('should return null for non-existent channel', async () => {
      const result = await repo.get('channel-999');
      expect(result).toBeNull();
    });

    it('should preserve optional fields', async () => {
      const channel = makeChannel({
        worktreeBranch: 'feat/test',
        parentChannelId: 'parent-1',
        lastMessage: 'Hello!',
        lastMessageAt: 1234567890,
      });
      await repo.save(channel);

      const result = await repo.get('channel-1');
      expect(result!.worktreeBranch).toBe('feat/test');
      expect(result!.parentChannelId).toBe('parent-1');
      expect(result!.lastMessage).toBe('Hello!');
      expect(result!.lastMessageAt).toBe(1234567890);
    });

    it('should upsert on conflict (same id)', async () => {
      await repo.save(makeChannel({ name: 'v1' }));
      await repo.save(makeChannel({ name: 'v2', cwd: '/new/path' }));

      const result = await repo.get('channel-1');
      expect(result!.name).toBe('v2');
      expect(result!.cwd).toBe('/new/path');
    });
  });

  describe('delete', () => {
    it('should delete a channel', async () => {
      await repo.save(makeChannel());

      const deleted = await repo.delete('channel-1');
      expect(deleted).toBe(true);

      const result = await repo.get('channel-1');
      expect(result).toBeNull();
    });

    it('should return false if channel does not exist', async () => {
      const deleted = await repo.delete('channel-999');
      expect(deleted).toBe(false);
    });
  });

  // ==================== Guild 级查询 ====================

  describe('getByGuild', () => {
    it('should retrieve all channels for a guild', async () => {
      await repo.save(makeChannel({ id: 'channel-1', name: 'C1' }));
      await repo.save(makeChannel({ id: 'channel-2', name: 'C2' }));
      await repo.save(makeChannel({ id: 'channel-3', guildId: 'guild-2', name: 'C3' }));

      const results = await repo.getByGuild('guild-1');
      expect(results).toHaveLength(2);
      expect(results.map((c) => c.id)).toContain('channel-1');
      expect(results.map((c) => c.id)).toContain('channel-2');
    });

    it('should return empty array if no channels exist', async () => {
      const results = await repo.getByGuild('guild-999');
      expect(results).toEqual([]);
    });
  });

  describe('getByGuildAndStatus', () => {
    it('should filter channels by status', async () => {
      await repo.save(makeChannel({ id: 'channel-1', status: 'active' }));
      await repo.save(makeChannel({ id: 'channel-2', status: 'archived', archivedAt: Date.now() }));
      await repo.save(makeChannel({ id: 'channel-3', status: 'active' }));

      const active = await repo.getByGuildAndStatus('guild-1', 'active');
      expect(active).toHaveLength(2);

      const archived = await repo.getByGuildAndStatus('guild-1', 'archived');
      expect(archived).toHaveLength(1);
      expect(archived[0].id).toBe('channel-2');
    });
  });

  // ==================== 归档 ====================

  describe('archive', () => {
    it('should archive a channel', async () => {
      await repo.save(makeChannel());

      const archived = await repo.archive('channel-1', 'user-1', 'Test reason');
      expect(archived).toBe(true);

      const result = await repo.get('channel-1');
      expect(result!.status).toBe('archived');
      expect(result!.archivedAt).toBeDefined();
      expect(result!.archivedBy).toBe('user-1');
      expect(result!.archiveReason).toBe('Test reason');
    });

    it('should return false if channel does not exist', async () => {
      const archived = await repo.archive('channel-999');
      expect(archived).toBe(false);
    });

    it('should allow archiving without userId and reason', async () => {
      await repo.save(makeChannel());

      await repo.archive('channel-1');

      const result = await repo.get('channel-1');
      expect(result!.status).toBe('archived');
      expect(result!.archivedBy).toBeUndefined();
      expect(result!.archiveReason).toBeUndefined();
    });
  });

  describe('restore', () => {
    it('should restore an archived channel', async () => {
      await repo.save(makeChannel({ status: 'archived', archivedAt: Date.now(), archivedBy: 'user-1' }));

      const restored = await repo.restore('channel-1');
      expect(restored).toBe(true);

      const result = await repo.get('channel-1');
      expect(result!.status).toBe('active');
      expect(result!.archivedAt).toBeUndefined();
      expect(result!.archivedBy).toBeUndefined();
      expect(result!.archiveReason).toBeUndefined();
    });

    it('should return false if channel does not exist', async () => {
      const restored = await repo.restore('channel-999');
      expect(restored).toBe(false);
    });
  });

  // ==================== 统计 ====================

  describe('count', () => {
    it('should count all channels', async () => {
      await repo.save(makeChannel({ id: 'channel-1' }));
      await repo.save(makeChannel({ id: 'channel-2' }));

      const count = await repo.count();
      expect(count).toBe(2);
    });

    it('should count channels by status', async () => {
      await repo.save(makeChannel({ id: 'channel-1', status: 'active' }));
      await repo.save(makeChannel({ id: 'channel-2', status: 'archived', archivedAt: Date.now() }));

      const activeCount = await repo.count('active');
      expect(activeCount).toBe(1);

      const archivedCount = await repo.count('archived');
      expect(archivedCount).toBe(1);
    });

    it('should return 0 if no channels exist', async () => {
      const count = await repo.count();
      expect(count).toBe(0);
    });
  });

  // ==================== loadAll ====================

  describe('loadAll', () => {
    it('should load all channels', () => {
      repo.save(makeChannel({ id: 'channel-1' }));
      repo.save(makeChannel({ id: 'channel-2', guildId: 'guild-2' }));

      const all = repo.loadAll();
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.id)).toContain('channel-1');
      expect(all.map((c) => c.id)).toContain('channel-2');
    });
  });
});
