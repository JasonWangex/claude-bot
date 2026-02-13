import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../session-repo.js';
import { createTestDb } from './test-helpers.js';
import type { Session } from '../../../types/index.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-001',
    name: 'Test Session',
    threadId: 'thread-1',
    guildId: 'guild-1',
    cwd: '/home/test',
    createdAt: Date.now(),
    messageHistory: [],
    messageCount: 0,
    ...overrides,
  };
}

describe('SessionRepository', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==================== CRUD ====================

  describe('save & get', () => {
    it('should save and retrieve a session', async () => {
      const session = makeSession();
      await repo.save(session);

      const result = await repo.get('guild-1', 'thread-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-001');
      expect(result!.name).toBe('Test Session');
      expect(result!.threadId).toBe('thread-1');
      expect(result!.guildId).toBe('guild-1');
      expect(result!.cwd).toBe('/home/test');
    });

    it('should return null for non-existent session', async () => {
      const result = await repo.get('guild-1', 'thread-999');
      expect(result).toBeNull();
    });

    it('should preserve optional fields', async () => {
      const session = makeSession({
        claudeSessionId: 'claude-123',
        prevClaudeSessionId: 'claude-122',
        lastMessage: 'Hello!',
        lastMessageAt: 1234567890,
        planMode: true,
        model: 'opus',
        parentThreadId: 'parent-1',
        worktreeBranch: 'feat/test',
      });
      await repo.save(session);

      const result = await repo.get('guild-1', 'thread-1');
      expect(result!.claudeSessionId).toBe('claude-123');
      expect(result!.prevClaudeSessionId).toBe('claude-122');
      expect(result!.lastMessage).toBe('Hello!');
      expect(result!.lastMessageAt).toBe(1234567890);
      expect(result!.planMode).toBe(true);
      expect(result!.model).toBe('opus');
      expect(result!.parentThreadId).toBe('parent-1');
      expect(result!.worktreeBranch).toBe('feat/test');
    });

    it('should upsert on conflict (same guild_id + thread_id)', async () => {
      await repo.save(makeSession({ name: 'v1' }));
      await repo.save(makeSession({ id: 'sess-001', name: 'v2', model: 'haiku' }));

      const result = await repo.get('guild-1', 'thread-1');
      expect(result!.name).toBe('v2');
      expect(result!.model).toBe('haiku');
    });
  });

  describe('message history', () => {
    it('should save and retrieve message history', async () => {
      const now = Date.now();
      const session = makeSession({
        messageHistory: [
          { role: 'user', text: 'Hi', timestamp: now },
          { role: 'assistant', text: 'Hello!', timestamp: now + 1 },
        ],
      });
      await repo.save(session);

      const result = await repo.get('guild-1', 'thread-1');
      expect(result!.messageHistory).toHaveLength(2);
      expect(result!.messageHistory[0].role).toBe('user');
      expect(result!.messageHistory[0].text).toBe('Hi');
      expect(result!.messageHistory[1].role).toBe('assistant');
      expect(result!.messageHistory[1].text).toBe('Hello!');
    });

    it('should replace message history on save', async () => {
      const now = Date.now();
      await repo.save(makeSession({
        messageHistory: [{ role: 'user', text: 'old', timestamp: now }],
      }));
      await repo.save(makeSession({
        messageHistory: [
          { role: 'user', text: 'new1', timestamp: now + 1 },
          { role: 'assistant', text: 'new2', timestamp: now + 2 },
        ],
      }));

      const result = await repo.get('guild-1', 'thread-1');
      expect(result!.messageHistory).toHaveLength(2);
      expect(result!.messageHistory[0].text).toBe('new1');
    });
  });

  describe('getAll', () => {
    it('should return all sessions for a guild', async () => {
      await repo.save(makeSession({ id: 's1', threadId: 't1' }));
      await repo.save(makeSession({ id: 's2', threadId: 't2' }));
      await repo.save(makeSession({ id: 's3', threadId: 't3', guildId: 'guild-2' }));

      const results = await repo.getAll('guild-1');
      expect(results).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should delete a session', async () => {
      await repo.save(makeSession());
      const deleted = await repo.delete('guild-1', 'thread-1');
      expect(deleted).toBe(true);

      const result = await repo.get('guild-1', 'thread-1');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent session', async () => {
      const deleted = await repo.delete('guild-1', 'thread-999');
      expect(deleted).toBe(false);
    });

    it('should cascade delete message history', async () => {
      const now = Date.now();
      await repo.save(makeSession({
        messageHistory: [{ role: 'user', text: 'hi', timestamp: now }],
      }));
      await repo.delete('guild-1', 'thread-1');

      // Verify message_history is also deleted
      const row = db.prepare('SELECT COUNT(*) as cnt FROM message_history WHERE session_id = ?').get('sess-001') as { cnt: number };
      expect(row.cnt).toBe(0);
    });
  });

  // ==================== 查询 ====================

  describe('findByClaudeSessionId', () => {
    it('should find session by Claude session ID', async () => {
      await repo.save(makeSession({ claudeSessionId: 'claude-abc' }));

      const result = await repo.findByClaudeSessionId('guild-1', 'claude-abc');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-001');
    });

    it('should return null when not found', async () => {
      const result = await repo.findByClaudeSessionId('guild-1', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findByParentThreadId', () => {
    it('should find child sessions', async () => {
      await repo.save(makeSession({ id: 's1', threadId: 't1', parentThreadId: 'parent-1' }));
      await repo.save(makeSession({ id: 's2', threadId: 't2', parentThreadId: 'parent-1' }));
      await repo.save(makeSession({ id: 's3', threadId: 't3', parentThreadId: 'parent-2' }));

      const results = await repo.findByParentThreadId('guild-1', 'parent-1');
      expect(results).toHaveLength(2);
    });
  });

  // ==================== 归档 ====================

  describe('archive', () => {
    it('should archive a session', async () => {
      await repo.save(makeSession());
      const archived = await repo.archive('guild-1', 'thread-1', 'user-1', 'test archive');
      expect(archived).toBe(true);

      // Original session should be gone
      const session = await repo.get('guild-1', 'thread-1');
      expect(session).toBeNull();

      // Archived session should exist
      const result = await repo.getArchived('guild-1', 'thread-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-001');
      expect(result!.archivedBy).toBe('user-1');
      expect(result!.archiveReason).toBe('test archive');
      expect(result!.archivedAt).toBeGreaterThan(0);
    });

    it('should return false for non-existent session', async () => {
      const archived = await repo.archive('guild-1', 'thread-999');
      expect(archived).toBe(false);
    });
  });

  describe('restore', () => {
    it('should restore an archived session', async () => {
      await repo.save(makeSession());
      await repo.archive('guild-1', 'thread-1');

      const restored = await repo.restore('guild-1', 'thread-1');
      expect(restored).toBe(true);

      // Session should be back
      const session = await repo.get('guild-1', 'thread-1');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('sess-001');

      // Archived should be gone
      const archived = await repo.getArchived('guild-1', 'thread-1');
      expect(archived).toBeNull();
    });

    it('should return false for non-existent archived session', async () => {
      const restored = await repo.restore('guild-1', 'thread-999');
      expect(restored).toBe(false);
    });
  });

  describe('getAllArchived', () => {
    it('should return all archived sessions for a guild', async () => {
      await repo.save(makeSession({ id: 's1', threadId: 't1' }));
      await repo.save(makeSession({ id: 's2', threadId: 't2' }));
      await repo.archive('guild-1', 't1');
      await repo.archive('guild-1', 't2');

      const results = await repo.getAllArchived('guild-1');
      expect(results).toHaveLength(2);
    });
  });

  // ==================== 统计 ====================

  describe('count', () => {
    it('should return total session count', async () => {
      expect(await repo.count()).toBe(0);

      await repo.save(makeSession({ id: 's1', threadId: 't1' }));
      expect(await repo.count()).toBe(1);

      await repo.save(makeSession({ id: 's2', threadId: 't2' }));
      expect(await repo.count()).toBe(2);
    });

    it('should not count archived sessions', async () => {
      await repo.save(makeSession({ id: 's1', threadId: 't1' }));
      await repo.save(makeSession({ id: 's2', threadId: 't2' }));
      await repo.archive('guild-1', 't1');

      expect(await repo.count()).toBe(1);
    });
  });
});
