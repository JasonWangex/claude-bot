'use client';

import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useDevLogs } from '@/lib/hooks/use-devlogs';
import { GitBranch, GitCommit, FileCode } from 'lucide-react';

export default function DevLogsPage() {
  const { data: devlogs, isLoading } = useDevLogs();

  return (
    <div className="space-y-6">
      <PageHeader
        title="DevLogs"
        description="开发日志时间线"
      />

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : !devlogs || devlogs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          暂无开发日志
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />

          <div className="space-y-4">
            {devlogs.map(log => (
              <div key={log.id} className="relative pl-10">
                {/* Timeline dot */}
                <div className="absolute left-[11px] top-4 h-2.5 w-2.5 rounded-full bg-primary border-2 border-background" />

                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">{log.name}</h3>
                        <span className="text-xs text-muted-foreground">{log.date}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="text-xs">
                          {log.project}
                        </Badge>
                        {log.goal && (
                          <Badge variant="outline" className="text-xs">
                            {log.goal}
                          </Badge>
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground">{log.summary}</p>

                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <GitBranch className="h-3 w-3" />
                          {log.branch}
                        </span>
                        <span className="flex items-center gap-1">
                          <GitCommit className="h-3 w-3" />
                          {log.commits} commits
                        </span>
                        <span className="flex items-center gap-1">
                          <FileCode className="h-3 w-3" />
                          {log.lines_changed}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
