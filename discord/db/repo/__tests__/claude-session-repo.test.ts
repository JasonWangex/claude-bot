import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ClaudeSessionRepository } from '../claude-session-repo.js';
import { ChannelRepository } from '../channel-repo.js';
import { createTestDb } from './test-helpers.js';
import type { ClaudeSession } from '../../../types/index.js';

function makeClaudeSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    id: 'session-001',
    planMode: false,
    status: 'active',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('ClaudeSessionRepository', () => {
  let db: Database.Database;
  let repo: ClaudeSessionRepository;
  let channelRepo: ChannelRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ClaudeSessionRepository(db);
    channelRepo = new ChannelRepository(db);

    // Create channels that will be referenced by foreign keys
    channelRepo.save({
      id: 'channel-1',
      guildId: 'guild-1',
      name: 'Channel 1',
      cwd: '/home/test',
      status: 'active',
      messageCount: 0,
      createdAt: Date.now(),
    });
    channelRepo.save({
      id: 'channel-2',
      guildId: 'guild-1',
      name: 'Channel 2',
      cwd: '/home/test',
      status: 'active',
      messageCount: 0,
      createdAt: Date.now(),
    });
  });

  afterEach(() => {
    db.close();
  });

  // ==================== CRUD ====================

  describe('save & get', () => {
    it('should save and retrieve a claude session', async () => {
      const session = makeClaudeSession();
      await repo.save(session);

      const result = await repo.get('session-001');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('session-001');
      expect(result!.planMode).toBe(false);
      expect(result!.status).toBe('active');
    });

    it('should return null for non-existent session', async () => {
      const result = await repo.get('session-999');
      expect(result).toBeNull();
    });

    it('should preserve optional fields', async () => {
      const session = makeClaudeSession({
        claudeSessionId: 'claude-123',
        prevClaudeSessionId: 'claude-122',
        channelId: 'channel-1',
        model: 'opus',
      });
      await repo.save(session);

      const result = await repo.get('session-001');
      expect(result!.claudeSessionId).toBe('claude-123');
      expect(result!.prevClaudeSessionId).toBe('claude-122');
      expect(result!.channelId).toBe('channel-1');
      expect(result!.model).toBe('opus');
    });

    it('should upsert on conflict (same id)', async () => {
      await repo.save(makeClaudeSession({ model: 'haiku' }));
      await repo.save(makeClaudeSession({ model: 'opus', planMode: true }));

      const result = await repo.get('session-001');
      expect(result!.model).toBe('opus');
      expect(result!.planMode).toBe(true);
    });
  });

  // ==================== Channel 查询 ====================

  describe('getByChannel', () => {
    it('should retrieve all sessions for a channel', async () => {
      await repo.save(makeClaudeSession({ id: 'session-1', channelId: 'channel-1' }));
      await repo.save(makeClaudeSession({ id: 'session-2', channelId: 'channel-1' }));
      await repo.save(makeClaudeSession({ id: 'session-3', channelId: 'channel-2' }));

      const results = await repo.getByChannel('channel-1');
      expect(results).toHaveLength(2);
      expect(results.map((s) => s.id)).toContain('session-1');
      expect(results.map((s) => s.id)).toContain('session-2');
    });

    it('should return empty array if no sessions exist', async () => {
      const results = await repo.getByChannel('channel-999');
      expect(results).toEqual([]);
    });

    it('should order results by created_at DESC', async () => {
      await repo.save(makeClaudeSession({ id: 'session-1', channelId: 'channel-1', createdAt: 1000 }));
      await repo.save(makeClaudeSession({ id: 'session-2', channelId: 'channel-1', createdAt: 2000 }));
      await repo.save(makeClaudeSession({ id: 'session-3', channelId: 'channel-1', createdAt: 1500 }));

      const results = await repo.getByChannel('channel-1');
      expect(results[0].id).toBe('session-2');
      expect(results[1].id).toBe('session-3');
      expect(results[2].id).toBe('session-1');
    });
  });

  describe('getActiveByChannel', () => {
    it('should retrieve the most recent active session for a channel', async () => {
      await repo.save(makeClaudeSession({ id: 'session-1', channelId: 'channel-1', status: 'active', createdAt: 1000 }));
      await repo.save(makeClaudeSession({ id: 'session-2', channelId: 'channel-1', status: 'active', createdAt: 2000 }));
      await repo.save(makeClaudeSession({ id: 'session-3', channelId: 'channel-1', status: 'closed', createdAt: 3000 }));

      const result = await repo.getActiveByChannel('channel-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('session-2');
    });

    it('should return null if no active sessions exist', async () => {
      await repo.save(makeClaudeSession({ channelId: 'channel-1', status: 'closed' }));

      const result = await repo.getActiveByChannel('channel-1');
      expect(result).toBeNull();
    });
  });

  describe('findByClaudeSessionId', () => {
    it('should find session by Claude CLI session_id', async () => {
      await repo.save(makeClaudeSession({ claudeSessionId: 'claude-123' }));

      const result = await repo.findByClaudeSessionId('claude-123');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('session-001');
    });

    it('should return null if not found', async () => {
      const result = await repo.findByClaudeSessionId('claude-999');
      expect(result).toBeNull();
    });
  });

  // ==================== close ====================

  describe('close', () => {
    it('should close a session', async () => {
      await repo.save(makeClaudeSession());

      const closed = await repo.close('session-001');
      expect(closed).toBe(true);

      const result = await repo.get('session-001');
      expect(result!.status).toBe('closed');
      expect(result!.closedAt).toBeDefined();
    });

    it('should return false if session does not exist', async () => {
      const closed = await repo.close('session-999');
      expect(closed).toBe(false);
    });
  });

  // ==================== loadAll ====================

  describe('loadAll', () => {
    it('should load all sessions', () => {
      repo.save(makeClaudeSession({ id: 'session-1' }));
      repo.save(makeClaudeSession({ id: 'session-2' }));

      const all = repo.loadAll();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.id)).toContain('session-1');
      expect(all.map((s) => s.id)).toContain('session-2');
    });
  });
});
