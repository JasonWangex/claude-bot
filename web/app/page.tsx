'use client';

import { Target, ListTodo, FileText, Lightbulb, Activity, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatsCard } from '@/components/dashboard/stats-card';
import { PageHeader } from '@/components/layout/page-header';
import { useGoals } from '@/lib/hooks/use-goals';
import { useTasks } from '@/lib/hooks/use-tasks';
import { useDevLogs } from '@/lib/hooks/use-devlogs';
import { useIdeas } from '@/lib/hooks/use-ideas';
import Link from 'next/link';
import { formatDistanceToNow } from '@/lib/format';

export default function DashboardPage() {
  const { data: goals } = useGoals();
  const { data: tasks } = useTasks();
  const { data: devlogs } = useDevLogs();
  const { data: ideas } = useIdeas();

  const activeGoals = goals?.filter(g => g.status === 'Active') ?? [];
  const totalTasks = tasks?.length ?? 0;
  const activeIdeas = ideas?.filter(i => i.status !== 'Done' && i.status !== 'Dropped') ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="系统概览"
      />

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          title="Active Goals"
          value={activeGoals.length}
          description={`共 ${goals?.length ?? 0} 个 Goals`}
          icon={Target}
        />
        <StatsCard
          title="Tasks"
          value={totalTasks}
          description="活跃的 Session/Task"
          icon={ListTodo}
        />
        <StatsCard
          title="DevLogs"
          value={devlogs?.length ?? 0}
          description="开发日志总数"
          icon={FileText}
        />
        <StatsCard
          title="Ideas"
          value={activeIdeas.length}
          description={`共 ${ideas?.length ?? 0} 个想法`}
          icon={Lightbulb}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Active Goals */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              Active Goals
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeGoals.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无活跃 Goal</p>
            ) : (
              <div className="space-y-3">
                {activeGoals.slice(0, 5).map(goal => (
                  <Link
                    key={goal.id}
                    href={`/goals/${goal.id}`}
                    className="flex items-center justify-between rounded-md border p-3 transition-colors hover:bg-accent"
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none">{goal.name}</p>
                      {goal.progress && (
                        <p className="text-xs text-muted-foreground">{goal.progress}</p>
                      )}
                    </div>
                    <Badge variant="outline">{goal.type ?? '未分类'}</Badge>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent DevLogs */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              最近 DevLogs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!devlogs || devlogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无开发日志</p>
            ) : (
              <div className="space-y-3">
                {devlogs.slice(0, 5).map(log => (
                  <div
                    key={log.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none">{log.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {log.project} · {log.commits} commits · {log.date}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
