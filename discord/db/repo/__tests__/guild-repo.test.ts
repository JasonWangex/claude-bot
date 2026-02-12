import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { GuildRepo } from '../guild-repo.js';
import { createTestDb } from './test-helpers.js';
import type { GuildState } from '../../../types/index.js';

function makeGuild(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guildId: 'guild-1',
    defaultCwd: '/home/bot',
    lastActivity: Date.now(),
    ...overrides,
  };
}

describe('GuildRepo', () => {
  let db: Database.Database;
  let repo: GuildRepo;

  beforeEach(() => {
    db = createTestDb();
    repo = new GuildRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('save & get', () => {
    it('should save and retrieve a guild', async () => {
      const guild = makeGuild();
      await repo.save(guild);

      const result = await repo.get('guild-1');
      expect(result).not.toBeNull();
      expect(result!.guildId).toBe('guild-1');
      expect(result!.defaultCwd).toBe('/home/bot');
    });

    it('should return null for non-existent guild', async () => {
      const result = await repo.get('guild-999');
      expect(result).toBeNull();
    });

    it('should preserve optional fields', async () => {
      await repo.save(makeGuild({ defaultModel: 'opus' }));

      const result = await repo.get('guild-1');
      expect(result!.defaultModel).toBe('opus');
    });

    it('should handle undefined defaultModel', async () => {
      await repo.save(makeGuild());

      const result = await repo.get('guild-1');
      expect(result!.defaultModel).toBeUndefined();
    });

    it('should upsert on conflict', async () => {
      await repo.save(makeGuild({ defaultCwd: '/old' }));
      await repo.save(makeGuild({ defaultCwd: '/new', defaultModel: 'haiku' }));

      const result = await repo.get('guild-1');
      expect(result!.defaultCwd).toBe('/new');
      expect(result!.defaultModel).toBe('haiku');
    });
  });

  describe('delete', () => {
    it('should delete a guild', async () => {
      await repo.save(makeGuild());
      const deleted = await repo.delete('guild-1');
      expect(deleted).toBe(true);

      const result = await repo.get('guild-1');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent guild', async () => {
      const deleted = await repo.delete('guild-999');
      expect(deleted).toBe(false);
    });
  });
});
