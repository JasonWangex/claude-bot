'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TaskStatusBadge } from './status-badge';
import { SkipForward, RotateCcw, CheckCircle, Pause, Play } from 'lucide-react';
import { skipTask, retryTask, markTaskDone, pauseGoalTask, resumeGoalTask } from '@/lib/hooks/use-goals';
import type { GoalTask } from '@/lib/types';

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
  const phases = new Map<number, GoalTask[]>();
  tasks.forEach(t => {
    const phase = t.phase ?? 0;
    if (!phases.has(phase)) phases.set(phase, []);
    phases.get(phase)!.push(t);
  });
  const sortedPhases = [...phases.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          任务列表 ({tasks.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {sortedPhases.map(([phase, phaseTasks]) => (
          <div key={phase}>
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">
              Phase {phase}
            </h4>
            <div className="space-y-2">
              {phaseTasks.map(task => (
                <div
                  key={task.id}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="flex-1 space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-muted-foreground">{task.id}</span>
                      <TaskStatusBadge status={task.status} />
                    </div>
                    <p className="text-sm">{task.description}</p>
                    {task.error && (
                      <p className="text-xs text-destructive">{task.error}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {task.status === 'failed' && (
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, () => retryTask(goalId, task.id))}
                        title="重试"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {task.type === '手动' && task.status === 'running' && (
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, () => markTaskDone(goalId, task.id))}
                        title="标记完成"
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {task.status === 'running' && (
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, () => pauseGoalTask(goalId, task.id))}
                        title="暂停"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {task.status === 'paused' && (
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, () => resumeGoalTask(goalId, task.id))}
                        title="恢复"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {(task.status === 'pending' || task.status === 'blocked') && (
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        disabled={acting === task.id}
                        onClick={() => handleAction(task.id, () => skipTask(goalId, task.id))}
                        title="跳过"
                      >
                        <SkipForward className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
