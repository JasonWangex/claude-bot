import { useState, useMemo } from 'react';
import { Card, Button, Space, Alert, Typography } from 'antd';
import {
  StepForwardOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  PauseOutlined,
  CaretRightOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { TaskStatusBadge } from './StatusBadge';
import { skipTask, retryTask, refixTask, markTaskDone, pauseGoalTask, resumeGoalTask } from '@/lib/hooks/use-goals';
import type { GoalTask } from '@/lib/types';

const { Text } = Typography;

interface TaskPanelProps {
  goalId: string;
  tasks: GoalTask[];
  onAction?: () => void;
}

export function TaskPanel({ goalId, tasks, onAction }: TaskPanelProps) {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (taskId: string, action: () => Promise<unknown>) => {
    setActing(taskId);
    setError(null);
    try {
      await action();
      onAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setActing(null);
    }
  };

  // Group by phase
  const sortedPhases = useMemo(() => {
    const phases = new Map<number, GoalTask[]>();
    tasks.forEach(t => {
      const phase = t.phase ?? 0;
      if (!phases.has(phase)) phases.set(phase, []);
      phases.get(phase)!.push(t);
    });
    return [...phases.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks]);

  return (
    <Card title={`任务列表 (${tasks.length})`} size="small">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {error && <Alert message={error} type="error" closable onClose={() => setError(null)} />}

        {sortedPhases.map(([phase, phaseTasks]) => (
          <div key={phase}>
            <Text type="secondary" strong style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
              Phase {phase}
            </Text>
            <Space direction="vertical" style={{ width: '100%' }} size="small">
              {phaseTasks.map(task => (
                <div
                  key={task.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: 12,
                    border: '1px solid #f0f0f0',
                    borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Space size={4} style={{ marginBottom: 4 }}>
                      <Text style={{ fontSize: 10, fontFamily: 'monospace' }} type="secondary">{task.id}</Text>
                      <TaskStatusBadge status={task.status} />
                    </Space>
                    <div style={{ fontSize: 14 }}>{task.description}</div>
                    {task.error && <Text type="danger" style={{ fontSize: 12 }}>{task.error}</Text>}
                  </div>
                  <Space size={4}>
                    {task.status === 'failed' && (
                      <>
                        <Button
                          type="text" size="small" icon={<ReloadOutlined />}
                          disabled={acting !== null && acting !== task.id}
                          loading={acting === task.id}
                          onClick={() => handleAction(task.id, () => retryTask(goalId, task.id))}
                          title="重试（从头开始）"
                        />
                        {task.threadId && (
                          <Button
                            type="text" size="small" icon={<ToolOutlined />}
                            disabled={acting !== null && acting !== task.id}
                            loading={acting === task.id}
                            onClick={() => handleAction(task.id, () => refixTask(goalId, task.id))}
                            title="重新修复（保留代码）"
                          />
                        )}
                      </>
                    )}
                    {task.type === '手动' && task.status === 'running' && (
                      <Button
                        type="text" size="small" icon={<CheckCircleOutlined />}
                        disabled={acting !== null && acting !== task.id}
                        loading={acting === task.id}
                        onClick={() => handleAction(task.id, () => markTaskDone(goalId, task.id))}
                        title="标记完成"
                      />
                    )}
                    {task.status === 'running' && (
                      <Button
                        type="text" size="small" icon={<PauseOutlined />}
                        disabled={acting !== null && acting !== task.id}
                        loading={acting === task.id}
                        onClick={() => handleAction(task.id, () => pauseGoalTask(goalId, task.id))}
                        title="暂停"
                      />
                    )}
                    {task.status === 'paused' && (
                      <Button
                        type="text" size="small" icon={<CaretRightOutlined />}
                        disabled={acting !== null && acting !== task.id}
                        loading={acting === task.id}
                        onClick={() => handleAction(task.id, () => resumeGoalTask(goalId, task.id))}
                        title="恢复"
                      />
                    )}
                    {(task.status === 'pending' || task.status === 'blocked') && (
                      <Button
                        type="text" size="small" icon={<StepForwardOutlined />}
                        disabled={acting !== null && acting !== task.id}
                        loading={acting === task.id}
                        onClick={() => handleAction(task.id, () => skipTask(goalId, task.id))}
                        title="跳过"
                      />
                    )}
                  </Space>
                </div>
              ))}
            </Space>
          </div>
        ))}
      </Space>
    </Card>
  );
}
