'use client';

import { use } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { GoalDAG } from '@/components/goals/goal-dag';
import { TaskPanel } from '@/components/goals/task-panel';
import { DriveControls } from '@/components/goals/drive-controls';
import { GoalStatusBadge } from '@/components/goals/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGoal, useGoalDrive } from '@/lib/hooks/use-goals';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function GoalDetailPage({ params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = use(params);
  const { data: goal } = useGoal(goalId);
  const { data: drive, mutate: mutateDrive } = useGoalDrive(goalId);

  if (!goal) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const tasks = drive?.tasks ?? [];
  const completed = tasks.filter(t => t.status === 'completed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const failed = tasks.filter(t => t.status === 'failed').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/goals" className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" />
          Goals
        </Link>
        <span>/</span>
        <span className="text-foreground">{goal.name}</span>
      </div>

      <PageHeader
        title={goal.name}
        actions={
          <div className="flex items-center gap-3">
            <GoalStatusBadge status={goal.status} />
            {drive && (
              <DriveControls
                goalId={goalId}
                status={drive.status}
                onAction={() => mutateDrive()}
              />
            )}
          </div>
        }
      />

      {/* Goal Meta Info */}
      <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
        {goal.type && <Badge variant="secondary">{goal.type}</Badge>}
        {goal.project && <Badge variant="secondary">{goal.project}</Badge>}
        {goal.progress && <span>{goal.progress}</span>}
      </div>

      {/* Task Stats */}
      {tasks.length > 0 && (
        <div className="flex gap-4 text-sm">
          <span>共 {tasks.length} 个任务</span>
          <span className="text-green-600">{completed} 完成</span>
          {running > 0 && <span className="text-blue-600">{running} 运行中</span>}
          {failed > 0 && <span className="text-red-600">{failed} 失败</span>}
        </div>
      )}

      {/* Main Content: DAG + Task Panel */}
      <Tabs defaultValue="dag">
        <TabsList>
          <TabsTrigger value="dag">DAG 依赖图</TabsTrigger>
          <TabsTrigger value="tasks">任务列表</TabsTrigger>
          {goal.body && <TabsTrigger value="detail">详情</TabsTrigger>}
        </TabsList>

        <TabsContent value="dag" className="mt-4">
          <GoalDAG tasks={tasks} />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <TaskPanel
            goalId={goalId}
            tasks={tasks}
            onAction={() => mutateDrive()}
          />
        </TabsContent>

        {goal.body && (
          <TabsContent value="detail" className="mt-4">
            <Card>
              <CardContent className="pt-6 prose prose-sm max-w-none">
                <pre className="whitespace-pre-wrap text-sm">{goal.body}</pre>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
