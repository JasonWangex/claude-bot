import { describe, it, expect } from 'vitest';
import type { GoalTask } from '../../types/index.js';
import type { ReplanChange } from '../replanner.js';
import {
  applyReplanChanges,
  renderTaskListMarkdown,
  updateGoalBodyWithTasks,
} from '../replanner.js';

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

function makeTasks(): GoalTask[] {
  return [
    makeTask({ id: 't1', description: '创建数据模型', status: 'completed', phase: 1 }),
    makeTask({ id: 't2', description: '实现 API', phase: 2, status: 'pending' }),
    makeTask({ id: 't3', description: '编写测试', phase: 2, status: 'pending' }),
    makeTask({ id: 't4', description: '手动部署', type: '手动', phase: 3, status: 'pending' }),
  ];
}

// ==================== applyReplanChanges ====================

describe('applyReplanChanges', () => {
  describe('add', () => {
    it('should add a new task', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'add',
        task: { id: 't5', description: '新任务', type: '代码', phase: 2 },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      expect(result.rejected).toHaveLength(0);
      expect(result.updatedTasks).toHaveLength(5);
      const added = result.updatedTasks.find(t => t.id === 't5');
      expect(added).toBeDefined();
      expect(added!.status).toBe('pending');
      expect(added!.phase).toBe(2);
    });

    it('should reject add with duplicate id', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'add',
        task: { id: 't2', description: '重复ID', type: '代码' },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain('already exists');
    });

    it('should allow adding multiple tasks in sequence', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [
        { action: 'add', task: { id: 't5', description: '步骤5', type: '代码', phase: 2 } },
        { action: 'add', task: { id: 't6', description: '步骤6', type: '代码', phase: 3 } },
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

    it('should modify task phase', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [{
        action: 'modify',
        taskId: 't3',
        updates: { phase: 3 },
      }];

      const result = applyReplanChanges(tasks, changes);

      expect(result.applied).toHaveLength(1);
      const modified = result.updatedTasks.find(t => t.id === 't3');
      expect(modified!.phase).toBe(3);
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

  describe('mixed changes', () => {
    it('should process multiple changes, partial success', () => {
      const tasks = makeTasks();
      const changes: ReplanChange[] = [
        { action: 'add', task: { id: 't5', description: '新任务', type: '代码', phase: 2 } },
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
        { action: 'add', task: { id: 't5', description: '新任务', type: '代码', phase: 2 } },
        { action: 'modify', taskId: 't2', updates: { description: 'changed' } },
      ]);

      expect(tasks).toHaveLength(originalLength);
      expect(tasks[1].description).toBe(originalDesc);
    });
  });
});

// ==================== renderTaskListMarkdown ====================

describe('renderTaskListMarkdown', () => {
  it('should render tasks as markdown table', () => {
    const tasks = [
      makeTask({ id: 't1', description: '创建数据模型', status: 'completed', type: '代码', phase: 1 }),
      makeTask({ id: 't2', description: '实现 API', phase: 2, status: 'running', type: '代码' }),
    ];

    const md = renderTaskListMarkdown(tasks);

    expect(md).toContain('## 子任务');
    expect(md).toContain('| ID | 类型 | 描述 | Phase | 状态 |');
    expect(md).toContain('| t1 | 代码 | 创建数据模型 | 1 | ✅ completed |');
    expect(md).toContain('| t2 | 代码 | 实现 API | 2 | 🔄 running |');
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

  it('should default to phase 1 when no phase set', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'pending' }), // no phase
    ];

    const md = renderTaskListMarkdown(tasks);
    expect(md).toContain('| t1 | 代码 |');
    expect(md).toContain('| 1 |'); // defaults to phase 1
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
