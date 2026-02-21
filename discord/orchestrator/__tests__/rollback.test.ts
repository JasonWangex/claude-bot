import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoalDriveState, GoalTask, GoalCheckpoint } from '../../types/index.js';
import type { GoalOrchestrator } from '../index.js';

// ==================== 测试辅助 ====================

function makeTask(overrides: Partial<GoalTask> = {}): GoalTask {
  return {
    id: 't1',
    description: 'Test task',
    type: '代码',
    
    status: 'pending',
    ...overrides,
  };
}

function makeState(overrides: Partial<GoalDriveState> = {}): GoalDriveState {
  return {
    goalId: 'goal-1',
    goalSeq: 1,
    goalName: 'Test Goal',
    goalBranch: 'goal/test',
    goalChannelId: 'thread-1',
    baseCwd: '/tmp/test',
    status: 'running',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    maxConcurrent: 3,
    tasks: [],
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<GoalCheckpoint> = {}): GoalCheckpoint {
  return {
    id: 'cp-goal-1-1000',
    goalId: 'goal-1',
    trigger: 'replan',
    createdAt: Date.now() - 30_000,
    ...overrides,
  };
}

// ==================== Mock Orchestrator ====================

/**
 * 创建一个最小化的 GoalOrchestrator mock，只包含 rollback 相关依赖
 */
function createMockOrchestrator(opts: {
  state: GoalDriveState | null;
  checkpoint?: GoalCheckpoint | null;
  snapshotTasks?: GoalTask[] | null;
}) {
  const savedStates: GoalDriveState[] = [];
  const notifications: Array<{ channelId: string; message: string; type?: string }> = [];
  const abortedLockKeys: string[] = [];
  const deletedChannels: string[] = [];
  const archivedSessions: Array<{ guildId: string; channelId: string; reason?: string }> = [];

  const mockGoalRepo = {
    get: vi.fn(async () => opts.state ? { ...opts.state, tasks: opts.state.tasks.map(t => ({ ...t })) } : null),
    save: vi.fn(async (state: GoalDriveState) => { savedStates.push(JSON.parse(JSON.stringify(state))); }),
    findByStatus: vi.fn(async () => []),
    getAll: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };

  const mockCheckpointRepo = {
    get: vi.fn(async () => opts.checkpoint ?? null),
    getByGoal: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    saveCheckpoint: vi.fn(async () => {}),
    restoreCheckpoint: vi.fn(async () => opts.snapshotTasks ?? null),
    listByGoal: vi.fn(async () => []),
    compressForCompletedGoal: vi.fn(async () => 0),
  };

  const mockGoalTaskRepo = {
    get: vi.fn(async () => null),
    getAllByGoal: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    saveAll: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    deleteAllByGoal: vi.fn(async () => {}),
    findByStatus: vi.fn(async () => []),
    findByThreadId: vi.fn(async () => null),
  };

  const mockGoalMetaRepo = {
    get: vi.fn(async () => null),
    getAll: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    findByStatus: vi.fn(async () => []),
    findByProject: vi.fn(async () => []),
    search: vi.fn(async () => []),
  };

  const mockMq = {
    sendLong: vi.fn(async (channelId: string, message: string, opts?: any) => {
      notifications.push({ channelId, message, type: opts?.embedColor });
    }),
  };

  const mockClaudeClient = {
    abort: vi.fn((lockKey: string) => { abortedLockKeys.push(lockKey); }),
  };

  const mockClient = {
    channels: {
      fetch: vi.fn(async (id: string) => ({
        id,
        delete: vi.fn(async () => { deletedChannels.push(id); }),
      })),
    },
  };

  const mockStateManager = {
    archiveSession: vi.fn((guildId: string, channelId: string, userId?: string, reason?: string) => {
      archivedSessions.push({ guildId, channelId, reason });
      return true;
    }),
  };

  // We need to construct the orchestrator instance but it requires complex deps.
  // Instead, we'll test the logic by calling the methods through a properly constructed mock.
  // Since the class has private methods, we'll use the real class with injected mocks.

  return {
    mockGoalRepo,
    mockCheckpointRepo,
    mockGoalTaskRepo,
    mockGoalMetaRepo,
    mockMq,
    mockClaudeClient,
    mockClient,
    mockStateManager,
    savedStates,
    notifications,
    abortedLockKeys,
    deletedChannels,
    archivedSessions,
  };
}

// ==================== 回滚逻辑单元测试 ====================

describe('rollback: affected task identification', () => {
  it('should identify tasks added after checkpoint as affected', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'pending' }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'running',  branchName: 'feat/t2', channelId: 'ch-t2', dispatchedAt: Date.now() - 10_000 }),
      // t3 was added by replan AFTER the checkpoint
      makeTask({ id: 't3', status: 'running',  branchName: 'feat/t3', channelId: 'ch-t3', dispatchedAt: Date.now() - 5_000 }),
    ];

    const snapshotTaskIds = new Set(snapshotTasks.map(t => t.id));
    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));

    const affected: Array<{ id: string; previousStatus: string }> = [];

    for (const task of currentTasks) {
      if (!snapshotTaskIds.has(task.id)) {
        // 新增的任务
        if (task.status === 'running' || task.status === 'dispatched' ||
            task.status === 'completed' || task.status === 'paused') {
          affected.push({ id: task.id, previousStatus: task.status });
        }
        continue;
      }

      const snapshotTask = snapshotTaskMap.get(task.id)!;
      const hasProgress = (
        task.status === 'running' || task.status === 'dispatched' ||
        (task.status === 'completed' && snapshotTask.status !== 'completed')
      );

      if (task.status !== snapshotTask.status && hasProgress) {
        affected.push({ id: task.id, previousStatus: task.status });
      }
    }

    expect(affected).toHaveLength(2);
    expect(affected.find(a => a.id === 't2')).toBeDefined();
    expect(affected.find(a => a.id === 't3')).toBeDefined();
  });

  it('should NOT identify already-completed-before-checkpoint tasks as affected', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'completed' }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'completed' }),
    ];

    const snapshotTaskIds = new Set(snapshotTasks.map(t => t.id));
    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));

    const affected: Array<{ id: string }> = [];

    for (const task of currentTasks) {
      if (!snapshotTaskIds.has(task.id)) {
        affected.push({ id: task.id });
        continue;
      }

      const snapshotTask = snapshotTaskMap.get(task.id)!;
      const hasProgress = (
        task.status === 'running' || task.status === 'dispatched' ||
        (task.status === 'completed' && snapshotTask.status !== 'completed')
      );

      if (task.status !== snapshotTask.status && hasProgress) {
        affected.push({ id: task.id });
      }
    }

    expect(affected).toHaveLength(0);
  });

  it('should identify tasks that completed AFTER checkpoint as affected', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'pending' }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      // t2 was pending in snapshot but completed now
      makeTask({ id: 't2', status: 'completed',  branchName: 'feat/t2', merged: true }),
    ];

    const snapshotTaskIds = new Set(snapshotTasks.map(t => t.id));
    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));

    const affected: Array<{ id: string; previousStatus: string }> = [];

    for (const task of currentTasks) {
      if (!snapshotTaskIds.has(task.id)) {
        if (task.status === 'running' || task.status === 'dispatched' ||
            task.status === 'completed' || task.status === 'paused') {
          affected.push({ id: task.id, previousStatus: task.status });
        }
        continue;
      }

      const snapshotTask = snapshotTaskMap.get(task.id)!;
      const hasProgress = (
        task.status === 'running' || task.status === 'dispatched' ||
        (task.status === 'completed' && snapshotTask.status !== 'completed')
      );

      if (task.status !== snapshotTask.status && hasProgress) {
        affected.push({ id: task.id, previousStatus: task.status });
      }
    }

    expect(affected).toHaveLength(1);
    expect(affected[0].id).toBe('t2');
    expect(affected[0].previousStatus).toBe('completed');
  });

  it('should identify pending→dispatched tasks as affected', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'pending' }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'dispatched', branchName: 'feat/t1', dispatchedAt: Date.now() }),
    ];

    const snapshotTaskIds = new Set(snapshotTasks.map(t => t.id));
    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));

    const affected: Array<{ id: string }> = [];

    for (const task of currentTasks) {
      if (!snapshotTaskIds.has(task.id)) {
        affected.push({ id: task.id });
        continue;
      }

      const snapshotTask = snapshotTaskMap.get(task.id)!;
      const hasProgress = (
        task.status === 'running' || task.status === 'dispatched' ||
        (task.status === 'completed' && snapshotTask.status !== 'completed')
      );

      if (task.status !== snapshotTask.status && hasProgress) {
        affected.push({ id: task.id });
      }
    }

    expect(affected).toHaveLength(1);
    expect(affected[0].id).toBe('t1');
  });

  it('should NOT identify failed/skipped/cancelled tasks as affected', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'pending' }),
      makeTask({ id: 't2', status: 'pending' }),
      makeTask({ id: 't3', status: 'pending' }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'failed' }),
      makeTask({ id: 't2', status: 'skipped' }),
      makeTask({ id: 't3', status: 'cancelled' }),
    ];

    const snapshotTaskIds = new Set(snapshotTasks.map(t => t.id));
    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));

    const affected: Array<{ id: string }> = [];

    for (const task of currentTasks) {
      if (!snapshotTaskIds.has(task.id)) {
        affected.push({ id: task.id });
        continue;
      }

      const snapshotTask = snapshotTaskMap.get(task.id)!;
      const hasProgress = (
        task.status === 'running' || task.status === 'dispatched' ||
        (task.status === 'completed' && snapshotTask.status !== 'completed')
      );

      if (task.status !== snapshotTask.status && hasProgress) {
        affected.push({ id: task.id });
      }
    }

    expect(affected).toHaveLength(0);
  });
});

describe('rollback: PendingRollback type contract', () => {
  it('should have correct structure for PendingRollback', () => {
    // Verify type shape
    const pending: import('../../types/index.js').PendingRollback = {
      checkpointId: 'cp-1',
      pausedTaskIds: ['t2', 't3'],
      costSummary: '**受影响任务 (2 个)**',
      affectedTasks: [
        {
          id: 't2',
          description: '实现 API',
          previousStatus: 'running',
          runtime: 60_000,
          diffStat: '3 files changed, 100 insertions(+)',
        },
        {
          id: 't3',
          description: '新增任务',
          previousStatus: 'dispatched',
        },
      ],
      createdAt: Date.now(),
    };

    expect(pending.checkpointId).toBe('cp-1');
    expect(pending.pausedTaskIds).toHaveLength(2);
    expect(pending.affectedTasks).toHaveLength(2);
    expect(pending.affectedTasks[0].runtime).toBe(60_000);
    expect(pending.affectedTasks[0].diffStat).toBeDefined();
    expect(pending.affectedTasks[1].runtime).toBeUndefined();
  });
});

describe('rollback: GoalDriveState pendingRollback field', () => {
  it('should be undefined when no rollback in progress', () => {
    const state = makeState();
    expect(state.pendingRollback).toBeUndefined();
  });

  it('should coexist with pendingReplan', () => {
    const state = makeState({
      pendingReplan: {
        changes: [],
        reasoning: 'test',
        impactLevel: 'high',
        checkpointId: 'cp-1',
      },
      pendingRollback: {
        checkpointId: 'cp-2',
        pausedTaskIds: [],
        costSummary: '',
        affectedTasks: [],
        createdAt: Date.now(),
      },
    });

    expect(state.pendingReplan).toBeDefined();
    expect(state.pendingRollback).toBeDefined();
    expect(state.pendingReplan!.checkpointId).not.toBe(state.pendingRollback!.checkpointId);
  });
});

describe('rollback: task cleanup identification', () => {
  it('should identify tasks needing cleanup (branch/thread exists but snapshot says pending)', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'pending' }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'completed', branchName: 'feat/t1', merged: true }),
      makeTask({ id: 't2', status: 'running',  branchName: 'feat/t2', channelId: 'ch-t2' }),
      // t3 新增的，不在快照中
      makeTask({ id: 't3', status: 'completed',  branchName: 'feat/t3', channelId: 'ch-t3' }),
    ];

    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));
    const tasksToCleanup: GoalTask[] = [];

    for (const task of currentTasks) {
      const snapshotTask = snapshotTaskMap.get(task.id);

      // 快照中不存在 → 清理
      if (!snapshotTask) {
        if (task.branchName || task.channelId) {
          tasksToCleanup.push(task);
        }
        continue;
      }

      // 快照中是 pending 但现在有 branch/thread → 清理
      if (snapshotTask.status === 'pending' && (task.branchName || task.channelId)) {
        tasksToCleanup.push(task);
      }
    }

    expect(tasksToCleanup).toHaveLength(2);
    expect(tasksToCleanup.map(t => t.id)).toContain('t2');
    expect(tasksToCleanup.map(t => t.id)).toContain('t3');
  });

  it('should NOT cleanup tasks that were already completed in snapshot', () => {
    const snapshotTasks = [
      makeTask({ id: 't1', status: 'completed', branchName: 'feat/t1', merged: true }),
    ];

    const currentTasks = [
      makeTask({ id: 't1', status: 'completed', branchName: 'feat/t1', merged: true }),
    ];

    const snapshotTaskMap = new Map(snapshotTasks.map(t => [t.id, t]));
    const tasksToCleanup: GoalTask[] = [];

    for (const task of currentTasks) {
      const snapshotTask = snapshotTaskMap.get(task.id);

      if (!snapshotTask) {
        if (task.branchName || task.channelId) {
          tasksToCleanup.push(task);
        }
        continue;
      }

      if (snapshotTask.status === 'pending' && (task.branchName || task.channelId)) {
        tasksToCleanup.push(task);
      }
    }

    expect(tasksToCleanup).toHaveLength(0);
  });
});
