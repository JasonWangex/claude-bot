/**
 * GoalEventRepo — goal 级别事件（如 goal.drive）的持久化
 *
 * UNIQUE(goal_id, event_type) 保证幂等写入，INSERT OR REPLACE 允许安全重试。
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export const GOAL_EVENT_TYPES = ['goal.drive'] as const;
export type GoalEventType = typeof GOAL_EVENT_TYPES[number];

export interface PendingGoalEvent {
  id: string;
  goalId: string;
  eventType: GoalEventType;
  payload: unknown;
}

interface GoalEventRow {
  id: string;
  goal_id: string;
  event_type: string;
  payload: string;
  source: string;
  created_at: number;
  processed_at: number | null;
}

export class GoalEventRepo {
  constructor(private db: Database.Database) {}

  write(goalId: string, type: GoalEventType, payload: unknown): void {
    this.db.prepare(`
      INSERT INTO goal_events (id, goal_id, event_type, payload, source, created_at, processed_at)
      VALUES (?, ?, ?, ?, 'ai', ?, NULL)
      ON CONFLICT(goal_id, event_type) DO UPDATE SET
        payload      = excluded.payload,
        source       = excluded.source,
        created_at   = excluded.created_at,
        processed_at = NULL
    `).run(randomUUID(), goalId, type, JSON.stringify(payload), Date.now());
  }

  findPending(): PendingGoalEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM goal_events WHERE processed_at IS NULL ORDER BY created_at ASC
    `).all() as GoalEventRow[];

    return rows.map(row => ({
      id: row.id,
      goalId: row.goal_id,
      eventType: row.event_type as GoalEventType,
      payload: (() => { try { return JSON.parse(row.payload); } catch { return {}; } })(),
    }));
  }

  markProcessed(id: string): void {
    this.db.prepare(`UPDATE goal_events SET processed_at = ? WHERE id = ?`).run(Date.now(), id);
  }
}
