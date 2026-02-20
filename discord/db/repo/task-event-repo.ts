/**
 * TaskEvent SQLite Repository
 *
 * AI → Orchestrator 事件通信的持久化层。
 * 替换原有的基于文件系统的 JSON 文件通信。
 *
 * 设计原则：
 * - UNIQUE(task_id, event_type) 保证幂等写入
 * - INSERT OR REPLACE 允许安全重试
 * - processed_at 供扫描器追踪处理状态
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export const EVENT_TYPES = [
  'feedback.main',
  'feedback.audit',
  'feedback.self_review',
  'feedback.investigate',
  'feedback.readiness',
  'brain.eval',
  'brain.failure',
  'brain.replan',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface PendingEvent {
  id: string;
  taskId: string;
  goalId: string | null;
  eventType: EventType;
  payload: unknown;
}

interface TaskEventRow {
  id: string;
  goal_id: string | null;
  task_id: string;
  event_type: string;
  payload: string;
  source: string;
  created_at: number;
  processed_at: number | null;
}

export class TaskEventRepo {
  private stmts: {
    write: Database.Statement;
    read: Database.Statement;
    findPending: Database.Statement;
    markProcessed: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      write: db.prepare(`
        INSERT INTO task_events
          (id, goal_id, task_id, event_type, payload, source, created_at, processed_at)
        VALUES
          (@id, @goal_id, @task_id, @event_type, @payload, @source, @created_at, NULL)
        ON CONFLICT(task_id, event_type) DO UPDATE SET
          payload      = excluded.payload,
          source       = excluded.source,
          created_at   = excluded.created_at,
          processed_at = NULL
      `),
      read: db.prepare(`
        SELECT * FROM task_events
        WHERE task_id = ? AND event_type = ?
        LIMIT 1
      `),
      findPending: db.prepare(`
        SELECT * FROM task_events
        WHERE processed_at IS NULL
        ORDER BY created_at ASC
      `),
      markProcessed: db.prepare(`
        UPDATE task_events SET processed_at = ? WHERE id = ?
      `),
    };
  }

  /** 写入事件（幂等，同 task_id + event_type 会覆盖旧值） */
  write(
    taskId: string,
    goalId: string | null,
    type: EventType,
    payload: unknown,
    source: 'ai' | 'brain',
  ): void {
    this.stmts.write.run({
      id: randomUUID(),
      goal_id: goalId,
      task_id: taskId,
      event_type: type,
      payload: JSON.stringify(payload),
      source,
      created_at: Date.now(),
    });
  }

  /** 读取指定 task 的最新事件，找不到返回 null */
  read<T = unknown>(taskId: string, type: EventType): T | null {
    const row = this.stmts.read.get(taskId, type) as TaskEventRow | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as T;
    } catch {
      return null;
    }
  }

  /** 扫描器专用：查找所有未处理事件 */
  findPending(): PendingEvent[] {
    const rows = this.stmts.findPending.all() as TaskEventRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      goalId: row.goal_id,
      eventType: row.event_type as EventType,
      payload: (() => {
        try {
          return JSON.parse(row.payload);
        } catch {
          return null;
        }
      })(),
    }));
  }

  /** 标记事件为已处理 */
  markProcessed(id: string): void {
    this.stmts.markProcessed.run(Date.now(), id);
  }
}
