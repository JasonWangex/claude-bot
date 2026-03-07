import { Card, Typography, Space } from 'antd';
import { Link } from 'react-router';
import { GoalStatusBadge } from './StatusBadge';
import type { Goal } from '@/lib/types';

const { Text } = Typography;

export function GoalCard({ goal }: { goal: Goal }) {
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
      </Card>
    </Link>
  );
}
