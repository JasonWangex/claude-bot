import { useMemo, useState } from 'react';
import { Typography, Select, Space, Empty, Spin, Row, Col, Alert } from 'antd';
import { GoalCard } from '@/components/goals/GoalCard';
import { useGoals } from '@/lib/hooks/use-goals';
import type { Goal } from '@/lib/types';

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

const UNGROUPED = '__ungrouped__';

function groupByProject(goals: Goal[]): { project: string; goals: Goal[] }[] {
  const map = new Map<string, Goal[]>();
  for (const goal of goals) {
    const key = goal.project || UNGROUPED;
    const list = map.get(key);
    if (list) list.push(goal);
    else map.set(key, [goal]);
  }
  // 有项目名的排前面（按名称排序），未分组的放最后
  const groups: { project: string; goals: Goal[] }[] = [];
  const keys = [...map.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    groups.push({ project: key, goals: map.get(key)! });
  }
  return groups;
}

export default function Goals() {
  const [statusFilter, setStatusFilter] = useState('all');
  const { data: goals, isLoading, error } = useGoals(
    statusFilter !== 'all' ? statusFilter : undefined
  );

  const grouped = useMemo(() => goals ? groupByProject(goals) : [], [goals]);

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
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {grouped.map(({ project, goals: projectGoals }) => (
            <div key={project}>
              <Title level={5} style={{ margin: '0 0 12px' }}>
                {project === UNGROUPED ? '未分类' : project}
                <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal', marginLeft: 8 }}>
                  {projectGoals.length}
                </Text>
              </Title>
              <Row gutter={[16, 16]}>
                {projectGoals.map(goal => (
                  <Col key={goal.id} xs={24} md={12} lg={8}>
                    <GoalCard goal={goal} />
                  </Col>
                ))}
              </Row>
            </div>
          ))}
        </Space>
      )}
    </Space>
  );
}
