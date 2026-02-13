'use client';

import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useIdeas } from '@/lib/hooks/use-ideas';
import { cn } from '@/lib/utils';
import type { IdeaStatus } from '@/lib/types';

const statusColors: Record<IdeaStatus, string> = {
  'Idea': 'bg-gray-100 text-gray-700 border-gray-200',
  'Processing': 'bg-blue-100 text-blue-700 border-blue-200',
  'Active': 'bg-green-100 text-green-700 border-green-200',
  'Paused': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  'Done': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Dropped': 'bg-red-100 text-red-700 border-red-200',
};

export default function IdeasPage() {
  const { data: ideas, isLoading } = useIdeas();

  // Group by status
  const grouped = new Map<IdeaStatus, typeof ideas>();
  const statusOrder: IdeaStatus[] = ['Idea', 'Processing', 'Active', 'Paused', 'Done', 'Dropped'];

  if (ideas) {
    for (const idea of ideas) {
      if (!grouped.has(idea.status)) grouped.set(idea.status, []);
      grouped.get(idea.status)!.push(idea);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ideas"
        description="想法管理"
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : !ideas || ideas.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          暂无想法记录
        </div>
      ) : (
        <div className="space-y-6">
          {statusOrder.map(status => {
            const items = grouped.get(status);
            if (!items || items.length === 0) return null;
            return (
              <div key={status}>
                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="outline" className={cn('text-xs', statusColors[status])}>
                    {status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">({items.length})</span>
                </div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {items.map(idea => (
                    <Card key={idea.id} className="hover:bg-accent/50 transition-colors">
                      <CardContent className="pt-4 pb-4">
                        <div className="space-y-2">
                          <p className="text-sm font-medium">{idea.name}</p>
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>{idea.project}</span>
                            <span>{idea.date}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
