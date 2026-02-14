import { Card, Progress, Typography, Tag, Space } from 'antd';
import { Link } from 'react-router';
import { GoalStatusBadge } from './StatusBadge';
import type { Goal } from '@/lib/types';

const { Text } = Typography;

function parseProgress(progress: string | null): { completed: number; total: number } | null {
  if (!progress) return null;
  const match = progress.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return { completed: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

export function GoalCard({ goal }: { goal: Goal }) {
  const isDone = goal.status === 'Completed' || goal.status === 'Merged';
  const prog = parseProgress(goal.progress);
  const percentage = isDone ? 100 : (prog && prog.total > 0 ? Math.round((prog.completed / prog.total) * 100) : 0);

  return (
    <Link to={`/goals/${goal.id}`}>
      <Card hoverable size="small">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text strong>{goal.name}</Text>
          <GoalStatusBadge status={goal.status} />
        </div>

        <Space size={4} style={{ fontSize: 12, color: '#999' }}>
          {goal.type && <span>{goal.type}</span>}
          {goal.project && <><span>·</span><span>{goal.project}</span></>}
          {goal.date && <><span>·</span><span>{goal.date}</span></>}
        </Space>

        {(isDone || prog) && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999' }}>
              <span>{isDone && prog ? `${prog.total}/${prog.total} 子任务完成` : goal.progress}</span>
              <span>{percentage}%</span>
            </div>
            <Progress percent={percentage} showInfo={false} size="small" status={isDone ? 'success' : 'active'} />
          </div>
        )}

        {!isDone && goal.next && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }} ellipsis>
            下一步: {goal.next}
          </Text>
        )}
        {!isDone && goal.blocked_by && (
          <Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }} ellipsis>
            卡点: {goal.blocked_by}
          </Text>
        )}
      </Card>
    </Link>
  );
}
