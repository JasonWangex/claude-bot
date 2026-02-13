import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { GoalTask, GoalTaskStatus } from '@/lib/types';

const statusBorderColors: Record<GoalTaskStatus, string> = {
  pending: 'border-gray-300',
  dispatched: 'border-indigo-400',
  running: 'border-blue-500 shadow-blue-100 shadow-md',
  completed: 'border-green-500',
  failed: 'border-red-500',
  blocked: 'border-orange-400',
  blocked_feedback: 'border-amber-400',
  paused: 'border-yellow-400',
  cancelled: 'border-gray-300',
  skipped: 'border-gray-300',
};

const statusBgColors: Record<GoalTaskStatus, string> = {
  pending: 'bg-white',
  dispatched: 'bg-indigo-50',
  running: 'bg-blue-50',
  completed: 'bg-green-50',
  failed: 'bg-red-50',
  blocked: 'bg-orange-50',
  blocked_feedback: 'bg-amber-50',
  paused: 'bg-yellow-50',
  cancelled: 'bg-gray-50',
  skipped: 'bg-gray-50',
};

const statusDotColors: Record<GoalTaskStatus, string> = {
  pending: 'bg-gray-400',
  dispatched: 'bg-indigo-500',
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  blocked: 'bg-orange-500',
  blocked_feedback: 'bg-amber-500',
  paused: 'bg-yellow-500',
  cancelled: 'bg-gray-400',
  skipped: 'bg-gray-400',
};

const statusLabels: Record<GoalTaskStatus, string> = {
  pending: '待执行',
  dispatched: '已派发',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  blocked: '阻塞',
  blocked_feedback: '需反馈',
  paused: '已暂停',
  cancelled: '已取消',
  skipped: '已跳过',
};

const typeLabels: Record<string, string> = {
  '代码': 'Code',
  '手动': 'Manual',
  '调研': 'Research',
  '占位': 'Placeholder',
};

type TaskNodeData = { task: GoalTask };

function TaskNodeComponent({ data }: { data: TaskNodeData }) {
  const { task } = data;

  return (
    <div
      className={cn(
        'rounded-lg border-2 px-4 py-3 min-w-[200px] max-w-[280px]',
        statusBorderColors[task.status],
        statusBgColors[task.status]
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-2 !h-2" />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono text-gray-400">{task.id}</span>
          <span className="text-[10px] text-gray-500">
            {typeLabels[task.type] ?? task.type}
          </span>
        </div>

        <p className="text-xs font-medium leading-snug line-clamp-2 text-gray-800">
          {task.description}
        </p>

        <div className="flex items-center gap-1.5">
          <span className={cn('inline-block h-2 w-2 rounded-full', statusDotColors[task.status])} />
          <span className="text-[10px] font-medium text-gray-600">
            {statusLabels[task.status]}
          </span>
          {task.merged && (
            <span className="text-[10px] text-green-600 ml-auto">merged</span>
          )}
        </div>

        {task.error && (
          <p className="text-[10px] text-red-500 line-clamp-1">{task.error}</p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-2 !h-2" />
    </div>
  );
}

export const TaskNode = memo(TaskNodeComponent);
