/**
 * IGoalRepo 的 SQLite 实现（已合并原 GoalMetaRepo）
 *
 * 统一管理 goals 表：
 * - Drive 运行状态（GoalDriveState）
 * - Goal 元数据（Goal）
 */

import type Database from 'better-sqlite3';
import type { IGoalRepo } from '../../types/repository.js';
import type { Goal, GoalStatus, GoalType } from '../../types/repository.js';
import type { GoalDriveState, GoalDriveStatus, TaskStatus } from '../../types/index.js';
import type { GoalRow, TaskRow } from '../../types/db.js';

const VALID_GOAL_STATUSES: GoalStatus[] = [
  'Pending', 'Collecting', 'Planned', 'Processing', 'Blocking',
  'Completed', 'Merged', 'Paused', 'Failed',
];

/** 安全解析 GoalStatus，旧数据 fallback 到 Pending */
function parseGoalStatus(value: string): GoalStatus {
  return VALID_GOAL_STATUSES.includes(value as GoalStatus)
    ? value as GoalStatus
    : 'Pending';
}

/** DB status（GoalStatus 大写）→ GoalDriveStatus（小写） */
function goalStatusToDriveStatus(status: string): GoalDriveStatus {
  const map: Record<string, GoalDriveStatus> = {
    Processing: 'running',
    Paused: 'paused',
    Completed: 'completed',
    Failed: 'failed',
    Blocking: 'paused',
  };
  return map[status] ?? 'running';
}

/** GoalDriveStatus（小写）→ DB status（GoalStatus 大写） */
function driveStatusToGoalStatus(status: GoalDriveStatus): GoalStatus {
  const map: Record<GoalDriveStatus, GoalStatus> = {
    running: 'Processing',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
  };
  return map[status] ?? 'Processing';
}

/** GoalRow → Goal (元数据视图) */
function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    status: parseGoalStatus(row.status),
    type: (row.type as GoalType) ?? null,
    project: row.project,
    date: row.date,
    completion: row.completion,
    body: row.body,
    seq: row.seq ?? null,
  };
}

export class GoalRepo implements IGoalRepo {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ==================== Drive 状态方法 ====================

  async get(goalId: string): Promise<GoalDriveState | null> {
    const row = this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(goalId) as GoalRow | undefined;
    if (!row || !row.branch) return null;

    const taskRows = this.db.prepare(
      `SELECT * FROM tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
    ).all(goalId) as TaskRow[];
    return rowsToGoalDriveState(row, taskRows);
  }

  async getAll(): Promise<GoalDriveState[]> {
    const rows = this.db.prepare(
      `SELECT * FROM goals WHERE status IN ('Processing', 'Paused', 'Blocking', 'Failed')`,
    ).all() as GoalRow[];
    const getTasksStmt = this.db.prepare(
      `SELECT * FROM tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
    );
    return rows.map((row) => {
      const taskRows = getTasksStmt.all(row.id) as TaskRow[];
      return rowsToGoalDriveState(row, taskRows);
    });
  }

  async save(state: GoalDriveState): Promise<void> {
    const saveTransaction = this.db.transaction(() => {
      // 1. Upsert goal row
      this.db.prepare(`
        INSERT INTO goals (
          id, name, status,
          branch, channel_id, cwd,
          max_concurrent,
          tech_lead_channel_id,
          phase_milestones
        ) VALUES (
          @id, @name, @status,
          @branch, @channel_id, @cwd,
          @max_concurrent,
          @tech_lead_channel_id,
          @phase_milestones
        )
        ON CONFLICT(id) DO UPDATE SET
          name = @name,
          status = @status,
          branch = @branch,
          channel_id = @channel_id,
          cwd = @cwd,
          max_concurrent = @max_concurrent,
          tech_lead_channel_id = @tech_lead_channel_id,
          phase_milestones = @phase_milestones
      `).run(goalDriveStateToGoalRow(state));

      if (state.tasks.length === 0) {
        this.db.prepare(`DELETE FROM tasks WHERE goal_id = ?`).run(state.goalId);
        return;
      }

      // 2. Upsert 各任务
      const upsertTask = this.db.prepare(`
        INSERT INTO tasks (
          id, goal_id, description, type, phase, status,
          branch_name, channel_id, dispatched_at, completed_at,
          error, merged, notified_blocked, feedback_json,
          complexity, pipeline_phase, audit_retries,
          tokens_in, tokens_out, cache_read_in, cache_write_in, cost_usd, duration_ms,
          detail_plan, audit_session_key, metadata_json,
          checkin_count, last_checkin_at, nudge_count, last_nudge_at
        ) VALUES (
          @id, @goal_id, @description, @type, @phase, @status,
          @branch_name, @channel_id, @dispatched_at, @completed_at,
          @error, @merged, @notified_blocked, @feedback_json,
          @complexity, @pipeline_phase, @audit_retries,
          @tokens_in, @tokens_out, @cache_read_in, @cache_write_in, @cost_usd, @duration_ms,
          @detail_plan, @audit_session_key, @metadata_json,
          @checkin_count, @last_checkin_at, @nudge_count, @last_nudge_at
        )
        ON CONFLICT(id) DO UPDATE SET
          status           = @status,
          description      = @description,
          type             = @type,
          phase            = @phase,
          branch_name      = @branch_name,
          channel_id       = @channel_id,
          dispatched_at    = @dispatched_at,
          completed_at     = @completed_at,
          error            = @error,
          merged           = @merged,
          notified_blocked = @notified_blocked,
          feedback_json    = @feedback_json,
          complexity       = @complexity,
          pipeline_phase   = @pipeline_phase,
          audit_retries    = @audit_retries,
          tokens_in        = @tokens_in,
          tokens_out       = @tokens_out,
          cache_read_in    = @cache_read_in,
          cache_write_in   = @cache_write_in,
          cost_usd         = @cost_usd,
          duration_ms      = @duration_ms,
          detail_plan      = @detail_plan,
          audit_session_key = @audit_session_key,
          metadata_json    = @metadata_json,
          checkin_count    = @checkin_count,
          last_checkin_at  = @last_checkin_at,
          nudge_count      = @nudge_count,
          last_nudge_at    = @last_nudge_at
      `);

      for (const task of state.tasks) {
        upsertTask.run({
          id: task.id,
          goal_id: state.goalId,
          description: task.description,
          type: task.type,
          phase: task.phase ?? null,
          status: task.status,
          branch_name: task.branchName ?? null,
          channel_id: task.channelId ?? null,
          dispatched_at: task.dispatchedAt ?? null,
          completed_at: task.completedAt ?? null,
          error: task.error ?? null,
          merged: task.merged ? 1 : 0,
          notified_blocked: task.notifiedBlocked ? 1 : 0,
          feedback_json: task.feedback ? JSON.stringify(task.feedback) : null,
          complexity: task.complexity ?? null,
          pipeline_phase: task.pipelinePhase ?? null,
          audit_retries: task.auditRetries ?? 0,
          tokens_in: task.tokensIn ?? null,
          tokens_out: task.tokensOut ?? null,
          cache_read_in: task.cacheReadIn ?? null,
          cache_write_in: task.cacheWriteIn ?? null,
          cost_usd: task.costUsd ?? null,
          duration_ms: task.durationMs ?? null,
          detail_plan: task.detailPlan ?? null,
          audit_session_key: task.auditSessionKey ?? null,
          metadata_json: task.metadata ? JSON.stringify(task.metadata) : null,
          checkin_count: task.checkinCount ?? 0,
          last_checkin_at: task.lastCheckinAt ?? null,
          nudge_count: task.nudgeCount ?? 0,
          last_nudge_at: task.lastNudgeAt ?? null,
        });
      }

      // 3. 删除孤儿任务
      const ids = state.tasks.map(t => t.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM tasks WHERE goal_id = ? AND id NOT IN (${placeholders})`)
        .run(state.goalId, ...ids);
    });

    saveTransaction();
  }

  async delete(goalId: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM goals WHERE id = ?`).run(goalId);
    return result.changes > 0;
  }


  async findByStatuses(statuses: GoalStatus[]): Promise<GoalDriveState[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM goals WHERE status IN (${placeholders})`,
    ).all(...statuses) as GoalRow[];
    const getTasksStmt = this.db.prepare(
      `SELECT * FROM tasks WHERE goal_id = ? ORDER BY phase ASC, id ASC`,
    );
    return rows.map((row) => rowsToGoalDriveState(row, getTasksStmt.all(row.id) as TaskRow[]));
  }

  // ==================== 元数据方法（原 GoalMetaRepo）====================

  async getMeta(goalId: string): Promise<Goal | null> {
    const row = this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(goalId) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  async getAllMeta(): Promise<Goal[]> {
    const rows = this.db.prepare(`SELECT * FROM goals ORDER BY date DESC`).all() as GoalRow[];
    return rows.map(rowToGoal);
  }

  async saveMeta(goal: Goal): Promise<void> {
    this.db.prepare(`
      INSERT INTO goals (id, name, status, type, project, date, completion, body, seq)
      VALUES (@id, @name, @status, @type, @project, @date, @completion, @body,
              COALESCE(@seq, (SELECT COALESCE(MAX(seq), 0) + 1 FROM goals)))
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        status = @status,
        type = @type,
        project = @project,
        date = @date,
        completion = @completion,
        body = @body
    `).run({
      id: goal.id,
      name: goal.name,
      status: goal.status,
      type: goal.type,
      project: goal.project,
      date: goal.date,
      completion: goal.completion,
      body: goal.body,
      seq: goal.seq,
    });
  }

  async findGoalsByStatus(status: GoalStatus): Promise<Goal[]> {
    const rows = this.db.prepare(
      `SELECT * FROM goals WHERE status = ? ORDER BY date DESC`,
    ).all(status) as GoalRow[];
    return rows.map(rowToGoal);
  }

  async findByProject(project: string): Promise<Goal[]> {
    const rows = this.db.prepare(
      `SELECT * FROM goals WHERE project = ? ORDER BY date DESC`,
    ).all(project) as GoalRow[];
    return rows.map(rowToGoal);
  }

  async search(query: string): Promise<Goal[]> {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM goals WHERE name LIKE ? OR body LIKE ? ORDER BY date DESC`,
    ).all(pattern, pattern) as GoalRow[];
    return rows.map(rowToGoal);
  }
}

// ==================== 转换函数 ====================

function goalDriveStateToGoalRow(state: GoalDriveState): Record<string, unknown> {
  return {
    id: state.goalId,
    name: state.goalName,
    status: driveStatusToGoalStatus(state.status),
    branch: state.branch,
    channel_id: state.channelId,
    cwd: state.cwd,
    max_concurrent: state.maxConcurrent,
    tech_lead_channel_id: state.techLeadChannelId ?? null,
    phase_milestones: state.phaseMilestones ? JSON.stringify(state.phaseMilestones) : null,
  };
}

function rowsToGoalDriveState(
  goal: GoalRow,
  tasks: TaskRow[],
): GoalDriveState {
  return {
    goalId: goal.id,
    goalSeq: goal.seq ?? 0,
    goalName: goal.name,
    branch: goal.branch ?? '',
    channelId: goal.channel_id ?? '',
    techLeadChannelId: goal.tech_lead_channel_id ?? undefined,
    phaseMilestones: goal.phase_milestones ? (() => { try { return JSON.parse(goal.phase_milestones); } catch { return undefined; } })() : undefined,
    cwd: goal.cwd ?? '',
    status: goalStatusToDriveStatus(goal.status),
    createdAt: 0,
    updatedAt: 0,
    maxConcurrent: goal.max_concurrent ?? 2,
    tasks: tasks.map((t) => ({
      id: t.id,
      goalId: t.goal_id ?? undefined,
      description: t.description,
      type: t.type,
      phase: t.phase ?? undefined,
      complexity: t.complexity ?? undefined,
      pipelinePhase: (t.pipeline_phase as GoalDriveState['tasks'][number]['pipelinePhase']) ?? undefined,
      auditRetries: t.audit_retries ?? 0,
      status: t.status as TaskStatus,
      branchName: t.branch_name ?? undefined,
      channelId: t.channel_id ?? undefined,
      dispatchedAt: t.dispatched_at ?? undefined,
      completedAt: t.completed_at ?? undefined,
      error: t.error ?? undefined,
      merged: t.merged === 1,
      notifiedBlocked: t.notified_blocked === 1,
      feedback: t.feedback_json ? JSON.parse(t.feedback_json) : undefined,
      tokensIn: t.tokens_in ?? undefined,
      tokensOut: t.tokens_out ?? undefined,
      cacheReadIn: t.cache_read_in ?? undefined,
      cacheWriteIn: t.cache_write_in ?? undefined,
      costUsd: t.cost_usd ?? undefined,
      durationMs: t.duration_ms ?? undefined,
      detailPlan: t.detail_plan ?? undefined,
      auditSessionKey: t.audit_session_key ?? undefined,
      metadata: t.metadata_json ? (() => { try { return JSON.parse(t.metadata_json); } catch { return undefined; } })() : undefined,
      checkinCount: t.checkin_count ?? 0,
      lastCheckinAt: t.last_checkin_at ?? null,
      nudgeCount: t.nudge_count ?? 0,
      lastNudgeAt: t.last_nudge_at ?? null,
    })),
  };
}
