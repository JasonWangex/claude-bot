/**
 * GoalTimeline SQLite Repository
 *
 * 持久化 Goal drive 过程中的关键事件，供 Web 端 Timeline 展示。
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export enum TimelineEventType {
  Success  = 'success',
  Error    = 'error',
  Warning  = 'warning',
  Info     = 'info',
  Pipeline = 'pipeline',
}

export interface GoalTimelineEvent {
  id: string;
  goalId: string;
  type: TimelineEventType;
  message: string;
  createdAt: number;
}

interface GoalTimelineRow {
  id: string;
  goal_id: string;
  type: string;
  message: string;
  created_at: number;
}

export class GoalTimelineRepo {
  private stmts: {
    append: Database.Statement;
    listByGoal: Database.Statement;
    deleteByGoal: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      append: db.prepare(
        'INSERT INTO goal_timeline (id, goal_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      listByGoal: db.prepare(
        'SELECT * FROM goal_timeline WHERE goal_id = ? ORDER BY created_at ASC',
      ),
      deleteByGoal: db.prepare(
        'DELETE FROM goal_timeline WHERE goal_id = ?',
      ),
    };
  }

  append(goalId: string, message: string, type: TimelineEventType = TimelineEventType.Info): void {
    this.stmts.append.run(randomUUID(), goalId, type, message, Date.now());
  }

  listByGoal(goalId: string): GoalTimelineEvent[] {
    const rows = this.stmts.listByGoal.all(goalId) as GoalTimelineRow[];
    return rows.map(r => ({
      id: r.id,
      goalId: r.goal_id,
      type: r.type as TimelineEventType,
      message: r.message,
      createdAt: r.created_at,
    }));
  }

  deleteByGoal(goalId: string): void {
    this.stmts.deleteByGoal.run(goalId);
  }
}
