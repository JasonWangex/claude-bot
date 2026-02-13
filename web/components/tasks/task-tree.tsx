'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, ChevronDown, GitBranch, Clock, MessageSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from '@/lib/format';
import type { TaskSummary } from '@/lib/types';

interface TaskTreeNodeProps {
  task: TaskSummary;
  depth?: number;
}

function TaskTreeNode({ task, depth = 0 }: TaskTreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = task.children && task.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-2.5 hover:bg-accent transition-colors group',
          depth > 0 && 'ml-6'
        )}
      >
        {/* Expand/Collapse */}
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-muted rounded"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="w-4.5" />
        )}

        {/* Task Info */}
        <Link
          href={`/tasks/${task.thread_id}`}
          className="flex-1 flex items-center gap-3 min-w-0"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{task.name}</span>
              {task.has_session && (
                <div className="h-2 w-2 rounded-full bg-green-500 shrink-0" title="有活跃 Session" />
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
              {task.worktree_branch && (
                <span className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  {task.worktree_branch}
                </span>
              )}
              {task.model && <span>{task.model}</span>}
              {task.last_message_at && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatDistanceToNow(task.last_message_at)}
                </span>
              )}
            </div>
          </div>
        </Link>

        {/* Last message preview */}
        {task.last_message && (
          <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden lg:inline">
            {task.last_message.slice(0, 60)}
          </span>
        )}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div className="border-l border-border ml-5">
          {task.children!.map(child => (
            <TaskTreeNode key={child.thread_id} task={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskTree({ tasks }: { tasks: TaskSummary[] }) {
  if (tasks.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        暂无 Task
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {tasks.map(task => (
        <TaskTreeNode key={task.thread_id} task={task} />
      ))}
    </div>
  );
}
