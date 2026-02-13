import { describe, it, expect } from 'vitest';
import type { GoalTask } from '../../types/index.js';
import type { ReplanChange } from '../replanner.js';
import {
  applyReplanChanges,
  validateDependencies,
  renderTaskListMarkdown,
  updateGoalBodyWithTasks,
} from '../replanner.js';

// ==================== 测试辅助 ====================

function makeTask(overrides: Partial<GoalTask> = {}): GoalTask {
  return {
    id: 't1',
    description: 'Test task',
    type: '代码',
    depends: [],
    status: 'pending',
    ...overrides,
  };
}

function makeTasks(): GoalTask[] {
  return [
    makeTask({ id: 't1', description: '创建数据模型', status: 'completed' }),
    makeTask({ id: 't2', description: '实现 API', depends: ['t1'], status: 'pending' }),
    makeTask({ id: 't3', description: '编写测试', depends: ['t2'], status: 'pending' }),
    makeTask({ id: 't4', description: '手动部署', type: '手动', depends: ['t3'], status: 'pending' }),
  ];
}

// ==================== applyReplanChanges ====================

describe('applyReplanChanges', () => {
  describe('add', () => {
    it('should add a new task', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'add',
        task: { id: 't5', description: '新任务', type: '代码', depends: ['t1'], phase: 2 },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      expect(result.rejected).toHaveLength(0);
      expect(result.updatedTasks).toHaveLength(5);
      const added = result.updatedTasks.find(t => t.id === 't5');
      expect(added).toBeDefined();
      expect(added!.status).toBe('pending');
      expect(added!.depends).toEqual(['t1']);
    });

    it('should reject add with duplicate id', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'add',
        task: { id: 't2', description: '重复ID', type: '代码', depends: [] },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('already exists');
    });

    it('should reject add with invalid dependency', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'add',
        task: { id: 't5', description: '新任务', type: '代码', depends: ['t99'] },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('Invalid depends');
    });

    it('should allow chaining: add t5, then add t6 depending on t5', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [
        { action: 'add', task: { id: 't5', description: '步骤5', type: '代码', depends: [] } },
        { action: 'add', task: { id: 't6', description: '步骤6', type: '代码', depends: ['t5'] } },
      ];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(2);
      expect(result.rejected).toHaveLength(0);
    });
  });

  describe('modify', () => {
    it('should modify task description', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't2',
        updates: { description: '更新后的 API' },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      const modified = result.updatedTasks.find(t => t.id === 't2');
      expect(modified!.description).toBe('更新后的 API');
    });

    it('should modify task depends', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't3',
        updates: { depends: ['t1'] },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      const modified = result.updatedTasks.find(t => t.id === 't3');
      expect(modified!.depends).toEqual(['t1']);
    });

    it('should reject modify on completed task', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't1',
        updates: { description: '不应被修改' },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('completed');
    });

    it('should reject modify on running task', () => {
      const tasks = makeTasks();
      tasks[1].status = 'running';
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't2',
        updates: { description: '不应被修改' },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('running');
    });

    it('should reject modify with invalid dependency reference', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't2',
        updates: { depends: ['t99'] },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('Invalid depends');
    });

    it('should reject modify on non-existent task', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't99',
        updates: { description: 'ghost' },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('not found');
    });
  });

  describe('remove', () => {
    it('should mark task as cancelled', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'remove',
        taskId: 't4',
        reason: 'not needed',
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      const removed = result.updatedTasks.find(t => t.id === 't4');
      expect(removed!.status).toBe('cancelled');
    });

    it('should reject remove on completed task', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'remove',
        taskId: 't1',
        reason: 'try to remove completed',
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
    });
  });

  describe('reorder', () => {
    it('should update depends and phase', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'reorder',
        taskId: 't3',
        newDepends: ['t1'],
        newPhase: 2,
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      const reordered = result.updatedTasks.find(t => t.id === 't3');
      expect(reordered!.depends).toEqual(['t1']);
      expect(reordered!.phase).toBe(2);
    });

    it('should reject reorder with invalid dependency reference', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'reorder',
        taskId: 't3',
        newDepends: ['t99'],
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('Invalid depends');
    });
  });

  describe('mixed changes', () => {
    it('should process multiple changes, partial success', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [
        { action: 'add', task: { id: 't5', description: '新任务', type: '代码', depends: ['t1'] } },
        { action: 'modify', taskId: 't1', updates: { description: '不可修改' } }, // rejected: completed
        { action: 'remove', taskId: 't4', reason: 'not needed' },
      ];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(2);
      expect(result.rejected).toHaveLength(1);
      expect(result.updatedTasks).toHaveLength(5); // 4 original + 1 added
    });

    it('should not mutate original task array', () => {
      const tasks = makeTasks();
      const originalLength = tasks.length;
      const originalDesc = tasks[1].description;

      applyReplanChanges(tasks, [
        { action: 'add', task: { id: 't5', description: '新任务', type: '代码', depends: [] } },
        { action: 'modify', taskId: 't2', updates: { description: 'changed' } },
      ]);

      expect(tasks).toHaveLength(originalLength);
      expect(tasks[1].description).toBe(originalDesc);
    });
  });
});

// ==================== validateDependencies ====================

describe('validateDependencies', () => {
  it('should pass for valid dependency graph', () => {
    const tasks = makeTasks();
    const result = validateDependencies(tasks);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect dangling dependency reference', () => {
    const tasks = [
      makeTask({ id: 't1', depends: ['t99'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('non-existent'))).toBe(true);
  });

  it('should detect simple circular dependency (A → B → A)', () => {
    const tasks = [
      makeTask({ id: 't1', depends: ['t2'], status: 'pending' }),
      makeTask({ id: 't2', depends: ['t1'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Circular'))).toBe(true);
  });

  it('should detect longer cycle (A → B → C → A)', () => {
    const tasks = [
      makeTask({ id: 't1', depends: ['t3'], status: 'pending' }),
      makeTask({ id: 't2', depends: ['t1'], status: 'pending' }),
      makeTask({ id: 't3', depends: ['t2'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Circular'))).toBe(true);
  });

  it('should detect self-dependency', () => {
    const tasks = [
      makeTask({ id: 't1', depends: ['t1'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Circular'))).toBe(true);
  });

  it('should ignore cancelled tasks in validation', () => {
    const tasks = [
      makeTask({ id: 't1', depends: [], status: 'pending' }),
      makeTask({ id: 't2', depends: ['t1'], status: 'cancelled' }),
      makeTask({ id: 't3', depends: ['t1'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);
    expect(result.valid).toBe(true);
  });

  it('should detect dependency on cancelled task', () => {
    const tasks = [
      makeTask({ id: 't1', depends: [], status: 'cancelled' }),
      makeTask({ id: 't2', depends: ['t1'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('cancelled'))).toBe(true);
  });

  it('should pass for tasks with no dependencies', () => {
    const tasks = [
      makeTask({ id: 't1', depends: [], status: 'pending' }),
      makeTask({ id: 't2', depends: [], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);
    expect(result.valid).toBe(true);
  });

  it('should pass for diamond dependency (no cycle)', () => {
    // t1 → t2 → t4
    // t1 → t3 → t4
    const tasks = [
      makeTask({ id: 't1', depends: [], status: 'completed' }),
      makeTask({ id: 't2', depends: ['t1'], status: 'pending' }),
      makeTask({ id: 't3', depends: ['t1'], status: 'pending' }),
      makeTask({ id: 't4', depends: ['t2', 't3'], status: 'pending' }),
    ];

    const result = validateDependencies(tasks);
    expect(result.valid).toBe(true);
  });
});

// ==================== renderTaskListMarkdown ====================

describe('renderTaskListMarkdown', () => {
  it('should render tasks as markdown table', () => {
    const tasks = [
      makeTask({ id: 't1', description: '创建数据模型', status: 'completed', type: '代码' }),
      makeTask({ id: 't2', description: '实现 API', depends: ['t1'], status: 'running', type: '代码' }),
    ];

    const md = renderTaskListMarkdown(tasks);

    expect(md).toContain('## 子任务');
    expect(md).toContain('| ID | 类型 | 描述 | 依赖 | 状态 |');
    expect(md).toContain('| t1 | 代码 | 创建数据模型 | — | ✅ completed |');
    expect(md).toContain('| t2 | 代码 | 实现 API | t1 | 🔄 running |');
  });

  it('should handle empty task list', () => {
    const md = renderTaskListMarkdown([]);

    expect(md).toContain('## 子任务');
    expect(md).toContain('| ID |');
    // No data rows
    const lines = md.split('\n');
    expect(lines).toHaveLength(4); // header + blank + table header + separator
  });

  it('should escape pipe characters in descriptions', () => {
    const tasks = [
      makeTask({ id: 't1', description: 'A | B', status: 'pending' }),
    ];

    const md = renderTaskListMarkdown(tasks);
    expect(md).toContain('A \\| B');
  });

  it('should join multiple depends with comma', () => {
    const tasks = [
      makeTask({ id: 't1', depends: ['t2', 't3'], status: 'pending' }),
    ];

    const md = renderTaskListMarkdown(tasks);
    expect(md).toContain('t2, t3');
  });
});

// ==================== updateGoalBodyWithTasks ====================

describe('updateGoalBodyWithTasks', () => {
  it('should create body from null', () => {
    const tasks = [makeTask({ id: 't1', status: 'pending' })];

    const result = updateGoalBodyWithTasks(null, tasks);

    expect(result).toContain('## 子任务');
    expect(result).toContain('t1');
  });

  it('should append to body without existing task section', () => {
    const body = '## 概述\n\n这是一个目标';
    const tasks = [makeTask({ id: 't1', status: 'pending' })];

    const result = updateGoalBodyWithTasks(body, tasks);

    expect(result).toContain('## 概述');
    expect(result).toContain('## 子任务');
  });

  it('should replace existing task section', () => {
    const body = '## 概述\n\n描述\n\n## 子任务\n\n旧内容\n\n## 备注\n\n备注内容';
    const tasks = [makeTask({ id: 't1', status: 'completed' })];

    const result = updateGoalBodyWithTasks(body, tasks);

    expect(result).toContain('## 概述');
    expect(result).toContain('## 子任务');
    expect(result).toContain('✅ completed');
    expect(result).not.toContain('旧内容');
    expect(result).toContain('## 备注');
  });
});
