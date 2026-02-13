'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { GoalCard } from '@/components/goals/goal-card';
import { useGoals } from '@/lib/hooks/use-goals';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GoalStatus } from '@/lib/types';

const statusOptions: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'Active', label: 'Active' },
  { value: 'Paused', label: 'Paused' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Done', label: 'Done' },
  { value: 'Idea', label: 'Idea' },
  { value: 'Abandoned', label: 'Abandoned' },
];

export default function GoalsPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { data: goals, isLoading } = useGoals(
    statusFilter !== 'all' ? statusFilter : undefined
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goals"
        description="开发目标管理"
        actions={
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="筛选状态" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : !goals || goals.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          暂无 Goal
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {goals.map(goal => (
            <GoalCard key={goal.id} goal={goal} />
          ))}
        </div>
      )}
    </div>
  );
}
