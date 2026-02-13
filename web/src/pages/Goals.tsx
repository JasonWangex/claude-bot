import { useState } from 'react';
import { Typography, Select, Space, Empty, Spin, Row, Col, Alert } from 'antd';
import { GoalCard } from '@/components/goals/GoalCard';
import { useGoals } from '@/lib/hooks/use-goals';

const { Title, Text } = Typography;

const statusOptions = [
  { value: 'all', label: '全部' },
  { value: 'Active', label: 'Active' },
  { value: 'Paused', label: 'Paused' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Done', label: 'Done' },
  { value: 'Idea', label: 'Idea' },
  { value: 'Abandoned', label: 'Abandoned' },
];

export default function Goals() {
  const [statusFilter, setStatusFilter] = useState('all');
  const { data: goals, isLoading, error } = useGoals(
    statusFilter !== 'all' ? statusFilter : undefined
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Goals</Title>
          <Text type="secondary">开发目标管理</Text>
        </div>
        <Select
          value={statusFilter}
          onChange={setStatusFilter}
          options={statusOptions}
          style={{ width: 140 }}
        />
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !goals || goals.length === 0 ? (
        <Empty description="暂无 Goal" />
      ) : (
        <Row gutter={[16, 16]}>
          {goals.map(goal => (
            <Col key={goal.id} xs={24} md={12} lg={8}>
              <GoalCard goal={goal} />
            </Col>
          ))}
        </Row>
      )}
    </Space>
  );
}
