import { Tag } from 'antd';
import type { GoalStatus, GoalTaskStatus } from '@/lib/types';

const goalStatusColors: Record<GoalStatus, string> = {
  'Pending': 'default',
  'Collecting': 'processing',
  'Planned': 'blue',
  'Processing': 'success',
  'Blocking': 'warning',
  'Paused': 'warning',
  'Completed': 'success',
  'Merged': 'default',
  'Failed': 'error',
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return <Tag color={goalStatusColors[status] ?? 'default'}>{status}</Tag>;
}

const taskStatusColors: Record<GoalTaskStatus, string> = {
  'pending': 'default',
  'dispatched': 'purple',
  'running': 'processing',
  'completed': 'success',
  'failed': 'error',
  'blocked': 'orange',
  'blocked_feedback': 'gold',
  'paused': 'warning',
  'cancelled': 'default',
  'skipped': 'default',
};

export const taskStatusLabels: Record<GoalTaskStatus, string> = {
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
  return <Tag color={taskStatusColors[status]}>{taskStatusLabels[status]}</Tag>;
}

