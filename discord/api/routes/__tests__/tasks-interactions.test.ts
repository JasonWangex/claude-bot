/**
 * 测试 GET /api/tasks/:threadId/interactions 端点
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrate.js';
import { InteractionLogRepository } from '../../../db/interaction-log-repo.js';
import migration001 from '../../../db/migrations/001_initial_schema.js';
import migration002 from '../../../db/migrations/002_add_goal_checkpoints.js';
import migration003 from '../../../db/migrations/003_add_pipeline_fields.js';
import migration004 from '../../../db/migrations/004_add_goal_seq.js';
import migration005 from '../../../db/migrations/005_add_interaction_log.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, [migration001, migration002, migration003, migration004, migration005]);
  return db;
}

describe('InteractionLogRepository', () => {
  let db: Database.Database;
  let repo: InteractionLogRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new InteractionLogRepository(db);
  });

  it('should insert and retrieve interaction logs', () => {
    const sessionId = 'test-session-123';
    const logs = [
      {
        session_id: sessionId,
        turn_index: 0,
        role: 'user' as const,
        content_type: 'text',
        summary_text: 'Hello, can you help me?',
        model: null,
        tokens_input: null,
        tokens_output: null,
        cost_usd: null,
        jsonl_path: '/tmp/test.jsonl',
        created_at: Date.now(),
      },
      {
        session_id: sessionId,
        turn_index: 1,
        role: 'assistant' as const,
        content_type: 'text',
        summary_text: 'Sure! How can I help?',
        model: 'claude-sonnet-4-5',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.001,
        jsonl_path: '/tmp/test.jsonl',
        created_at: Date.now(),
      },
    ];

    repo.insertBatch(logs);

    const retrieved = repo.findBySession(sessionId);
    expect(retrieved).toHaveLength(2);
    expect(retrieved[0].role).toBe('user');
    expect(retrieved[1].role).toBe('assistant');
    expect(retrieved[1].model).toBe('claude-sonnet-4-5');
  });

  it('should return empty array for non-existent session', () => {
    const retrieved = repo.findBySession('non-existent-session');
    expect(retrieved).toHaveLength(0);
  });

  it('should preserve insertion order (turn_index, role)', () => {
    const sessionId = 'test-session-456';
    const logs = [
      {
        session_id: sessionId,
        turn_index: 1,
        role: 'assistant' as const,
        content_type: 'text',
        summary_text: 'Response 1',
        model: 'claude-sonnet-4-5',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.001,
        jsonl_path: '/tmp/test.jsonl',
        created_at: Date.now(),
      },
      {
        session_id: sessionId,
        turn_index: 0,
        role: 'user' as const,
        content_type: 'text',
        summary_text: 'Question 0',
        model: null,
        tokens_input: null,
        tokens_output: null,
        cost_usd: null,
        jsonl_path: '/tmp/test.jsonl',
        created_at: Date.now(),
      },
    ];

    repo.insertBatch(logs);

    const retrieved = repo.findBySession(sessionId);
    expect(retrieved).toHaveLength(2);
    // Should be ordered by turn_index, role
    expect(retrieved[0].turn_index).toBe(0);
    expect(retrieved[1].turn_index).toBe(1);
  });

  it('should handle duplicate insertions gracefully (INSERT OR IGNORE)', () => {
    const sessionId = 'test-session-789';
    const log = {
      session_id: sessionId,
      turn_index: 0,
      role: 'user' as const,
      content_type: 'text',
      summary_text: 'First insert',
      model: null,
      tokens_input: null,
      tokens_output: null,
      cost_usd: null,
      jsonl_path: '/tmp/test.jsonl',
      created_at: Date.now(),
    };

    // Insert same log twice
    repo.insertBatch([log]);
    repo.insertBatch([log]);

    const retrieved = repo.findBySession(sessionId);
    // Should only have one entry due to UNIQUE constraint
    expect(retrieved).toHaveLength(1);
  });

  it('should delete all interactions for a session', () => {
    const sessionId = 'test-session-delete';
    const logs = [
      {
        session_id: sessionId,
        turn_index: 0,
        role: 'user' as const,
        content_type: 'text',
        summary_text: 'Test',
        model: null,
        tokens_input: null,
        tokens_output: null,
        cost_usd: null,
        jsonl_path: '/tmp/test.jsonl',
        created_at: Date.now(),
      },
    ];

    repo.insertBatch(logs);
    expect(repo.findBySession(sessionId)).toHaveLength(1);

    const deletedCount = repo.deleteBySession(sessionId);
    expect(deletedCount).toBe(1);
    expect(repo.findBySession(sessionId)).toHaveLength(0);
  });
});
