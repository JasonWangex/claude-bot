import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { GoalStatus, GoalTaskStatus, GoalDriveStatus } from '@/lib/types';

const goalStatusColors: Record<GoalStatus, string> = {
  'Idea': 'bg-gray-100 text-gray-700 border-gray-200',
  'Processing': 'bg-blue-100 text-blue-700 border-blue-200',
  'Active': 'bg-green-100 text-green-700 border-green-200',
  'Paused': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  'Done': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Abandoned': 'bg-red-100 text-red-700 border-red-200',
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return (
    <Badge variant="outline" className={cn('text-xs', goalStatusColors[status])}>
      {status}
    </Badge>
  );
}

const taskStatusColors: Record<GoalTaskStatus, string> = {
  'pending': 'bg-gray-100 text-gray-600 border-gray-200',
  'dispatched': 'bg-indigo-100 text-indigo-600 border-indigo-200',
  'running': 'bg-blue-100 text-blue-700 border-blue-200',
  'completed': 'bg-green-100 text-green-700 border-green-200',
  'failed': 'bg-red-100 text-red-700 border-red-200',
  'blocked': 'bg-orange-100 text-orange-700 border-orange-200',
  'blocked_feedback': 'bg-amber-100 text-amber-700 border-amber-200',
  'paused': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  'cancelled': 'bg-gray-200 text-gray-500 border-gray-300',
  'skipped': 'bg-gray-200 text-gray-500 border-gray-300',
};

const taskStatusLabels: Record<GoalTaskStatus, string> = {
  'pending': '待执行',
  'dispatched': '已派发',
  'running': '运行中',
  'completed': '完成',
  'failed': '失败',
  'blocked': '阻塞',
  'blocked_feedback': '需反馈',
  'paused': '已暂停',
  'cancelled': '已取消',
  'skipped': '已跳过',
};

export function TaskStatusBadge({ status }: { status: GoalTaskStatus }) {
  return (
    <Badge variant="outline" className={cn('text-xs', taskStatusColors[status])}>
      {taskStatusLabels[status]}
    </Badge>
  );
}

const driveStatusColors: Record<GoalDriveStatus, string> = {
  'running': 'bg-blue-100 text-blue-700 border-blue-200',
  'paused': 'bg-yellow-100 text-yellow-700 border-yellow-200',
  'completed': 'bg-green-100 text-green-700 border-green-200',
  'failed': 'bg-red-100 text-red-700 border-red-200',
};

export function DriveStatusBadge({ status }: { status: GoalDriveStatus }) {
  return (
    <Badge variant="outline" className={cn('text-xs', driveStatusColors[status])}>
      {status}
    </Badge>
  );
}
