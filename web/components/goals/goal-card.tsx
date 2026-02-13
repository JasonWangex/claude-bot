import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { GoalStatusBadge } from './status-badge';
import type { Goal } from '@/lib/types';

function parseProgress(progress: string | null): { completed: number; total: number } | null {
  if (!progress) return null;
  const match = progress.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return { completed: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

export function GoalCard({ goal }: { goal: Goal }) {
  const prog = parseProgress(goal.progress);
  const percentage = prog && prog.total > 0 ? Math.round((prog.completed / prog.total) * 100) : 0;

  return (
    <Link href={`/goals/${goal.id}`}>
      <Card className="transition-colors hover:bg-accent/50 cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">{goal.name}</CardTitle>
            <GoalStatusBadge status={goal.status} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {goal.type && <span>{goal.type}</span>}
              {goal.project && (
                <>
                  <span>·</span>
                  <span>{goal.project}</span>
                </>
              )}
              {goal.date && (
                <>
                  <span>·</span>
                  <span>{goal.date}</span>
                </>
              )}
            </div>
            {prog && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{goal.progress}</span>
                  <span>{percentage}%</span>
                </div>
                <Progress value={percentage} className="h-1.5" />
              </div>
            )}
            {goal.next && (
              <p className="text-xs text-muted-foreground line-clamp-1">
                下一步: {goal.next}
              </p>
            )}
            {goal.blocked_by && (
              <p className="text-xs text-destructive line-clamp-1">
                卡点: {goal.blocked_by}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
