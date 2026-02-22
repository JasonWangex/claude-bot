import type { Migration } from '../migrate.js';

/**
 * Migration 037: 创建 deleted_task_events 和 deleted_goal_events 日志表
 *
 * 用途：仅用于 debug，保存所有被删除的 events 记录，不参与业务逻辑。
 *
 * 实现机制：通过 SQLite BEFORE DELETE 触发器自动存档。
 *
 * 注意：SQLite 的 ON DELETE CASCADE 不会触发子表的 BEFORE DELETE 触发器，
 * 因此需要在父表（tasks、goals）上额外添加触发器，在级联发生前先存档数据。
 *
 * 触发器覆盖的场景：
 *   - trg_task_events_before_delete：直接 DELETE FROM task_events（如 clearByTask）
 *   - trg_tasks_before_delete：直接 DELETE FROM tasks，在级联删除 task_events 前存档
 *   - trg_goals_before_delete：直接 DELETE FROM goals，在级联删除前存档 task_events（goal_events 无级联，不在此处归档）
 *   - trg_goal_events_before_delete：直接 DELETE FROM goal_events（当前无此操作，备用）
 */
const migration: Migration = {
  version: 37,
  name: 'create_deleted_events_log',

  up(db) {
    // 1. 创建日志表
    db.exec(`
      CREATE TABLE IF NOT EXISTS deleted_task_events (
        id           TEXT NOT NULL,
        goal_id      TEXT,
        task_id      TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        payload      TEXT NOT NULL,
        source       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        processed_at INTEGER,
        deleted_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deleted_task_events_task_id
        ON deleted_task_events(task_id);

      CREATE INDEX IF NOT EXISTS idx_deleted_task_events_deleted_at
        ON deleted_task_events(deleted_at);

      CREATE TABLE IF NOT EXISTS deleted_goal_events (
        id           TEXT NOT NULL,
        goal_id      TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        payload      TEXT NOT NULL,
        source       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        processed_at INTEGER,
        deleted_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deleted_goal_events_goal_id
        ON deleted_goal_events(goal_id);

      CREATE INDEX IF NOT EXISTS idx_deleted_goal_events_deleted_at
        ON deleted_goal_events(deleted_at);
    `);

    // 2. 触发器：task_events 直接删除时存档（处理 clearByTask 等显式删除）
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_task_events_before_delete
        BEFORE DELETE ON task_events
      BEGIN
        INSERT INTO deleted_task_events
          (id, goal_id, task_id, event_type, payload, source, created_at, processed_at, deleted_at)
        VALUES
          (OLD.id, OLD.goal_id, OLD.task_id, OLD.event_type, OLD.payload, OLD.source,
           OLD.created_at, OLD.processed_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
      END;
    `);

    // 3. 触发器：tasks 直接删除前，先存档该 task 的 task_events
    //    （处理 deleteTask、deleteAllByGoal 等直接删 tasks 场景，避免级联后触发器失效）
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_tasks_before_delete
        BEFORE DELETE ON tasks
      BEGIN
        INSERT INTO deleted_task_events
          (id, goal_id, task_id, event_type, payload, source, created_at, processed_at, deleted_at)
        SELECT id, goal_id, task_id, event_type, payload, source, created_at, processed_at,
               CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM task_events
        WHERE task_id = OLD.id;
      END;
    `);

    // 4. 触发器：goals 直接删除前，先存档该 goal 的 task_events
    //    （处理 goal 级联删除场景，goals → tasks → task_events 整链不触发子表触发器）
    //    注意：goal_events 无 REFERENCES goals(id) ON DELETE CASCADE，删 goal 不会级联删 goal_events，
    //    故不在此处归档 goal_events，避免将未删除的记录误写入 deleted_goal_events。
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_goals_before_delete
        BEFORE DELETE ON goals
      BEGIN
        INSERT INTO deleted_task_events
          (id, goal_id, task_id, event_type, payload, source, created_at, processed_at, deleted_at)
        SELECT te.id, te.goal_id, te.task_id, te.event_type, te.payload, te.source,
               te.created_at, te.processed_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM task_events te
        JOIN tasks t ON te.task_id = t.id
        WHERE t.goal_id = OLD.id;
      END;
    `);

    // 5. 触发器：goal_events 直接删除时存档（当前无此操作，备用）
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_goal_events_before_delete
        BEFORE DELETE ON goal_events
      BEGIN
        INSERT INTO deleted_goal_events
          (id, goal_id, event_type, payload, source, created_at, processed_at, deleted_at)
        VALUES
          (OLD.id, OLD.goal_id, OLD.event_type, OLD.payload, OLD.source,
           OLD.created_at, OLD.processed_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
      END;
    `);
  },

  down(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_goal_events_before_delete;
      DROP TRIGGER IF EXISTS trg_goals_before_delete;
      DROP TRIGGER IF EXISTS trg_tasks_before_delete;
      DROP TRIGGER IF EXISTS trg_task_events_before_delete;
      DROP INDEX IF EXISTS idx_deleted_goal_events_deleted_at;
      DROP INDEX IF EXISTS idx_deleted_goal_events_goal_id;
      DROP TABLE IF EXISTS deleted_goal_events;
      DROP INDEX IF EXISTS idx_deleted_task_events_deleted_at;
      DROP INDEX IF EXISTS idx_deleted_task_events_task_id;
      DROP TABLE IF EXISTS deleted_task_events;
    `);
  },
};

export default migration;
