'use client';

import { use } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { MessageHistory } from '@/components/tasks/message-history';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTask } from '@/lib/hooks/use-tasks';
import { TaskTree } from '@/components/tasks/task-tree';
import { GitBranch, FolderOpen, Clock, Bot } from 'lucide-react';
import { formatDistanceToNow } from '@/lib/format';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function TaskDetailPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = use(params);
  const { data: task } = useTask(threadId);

  if (!task) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/tasks" className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" />
          Tasks
        </Link>
        <span>/</span>
        <span className="text-foreground">{task.name}</span>
      </div>

      <PageHeader title={task.name} />

      {/* Session Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Session 信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="truncate">{task.cwd}</span>
            </div>
            {task.model && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Bot className="h-4 w-4 shrink-0" />
                <span>{task.model}</span>
              </div>
            )}
            {task.worktree_branch && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <GitBranch className="h-4 w-4 shrink-0" />
                <span>{task.worktree_branch}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              <span>创建于 {formatDistanceToNow(task.created_at)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Children Tasks */}
      {task.children && task.children.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">子任务 ({task.children.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <TaskTree tasks={task.children} />
          </CardContent>
        </Card>
      )}

      {/* Message History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            消息历史 ({task.message_history.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MessageHistory messages={task.message_history} />
        </CardContent>
      </Card>
    </div>
  );
}
