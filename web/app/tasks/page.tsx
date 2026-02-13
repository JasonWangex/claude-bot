'use client';

import { PageHeader } from '@/components/layout/page-header';
import { TaskTree } from '@/components/tasks/task-tree';
import { Card, CardContent } from '@/components/ui/card';
import { useTasks } from '@/lib/hooks/use-tasks';

export default function TasksPage() {
  const { data: tasks, isLoading } = useTasks();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Session / Task 管理"
      />

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : (
            <TaskTree tasks={tasks ?? []} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
