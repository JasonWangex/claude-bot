import { Card, Typography, Tag, Progress, Space, Empty, Row, Col } from 'antd';
import {
  AimOutlined,
  UnorderedListOutlined,
  FileTextOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router';
import { StatsCard } from '@/components/StatsCard';
import { useGoals } from '@/lib/hooks/use-goals';
import { useTasks } from '@/lib/hooks/use-tasks';
import { useDevLogs } from '@/lib/hooks/use-devlogs';
import { useIdeas } from '@/lib/hooks/use-ideas';
import { formatDateTime } from '@/lib/format';

const { Title, Text } = Typography;

export default function Dashboard() {
  const { data: goals } = useGoals();
  const { data: tasks } = useTasks();
  const { data: devlogs } = useDevLogs();
  const { data: ideas } = useIdeas();

  const activeGoals = goals?.filter(g => g.status === 'Active') ?? [];
  const totalTasks = tasks?.length ?? 0;
  const activeIdeas = ideas?.filter(i => i.status !== 'Done' && i.status !== 'Dropped') ?? [];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>Dashboard</Title>
      <Text type="secondary">系统概览</Text>

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <StatsCard title="Active Goals" value={activeGoals.length} icon={<AimOutlined />} description={`/ ${goals?.length ?? 0}`} />
        </Col>
        <Col xs={12} lg={6}>
          <StatsCard title="Tasks" value={totalTasks} icon={<UnorderedListOutlined />} description="活跃" />
        </Col>
        <Col xs={12} lg={6}>
          <StatsCard title="DevLogs" value={devlogs?.length ?? 0} icon={<FileTextOutlined />} />
        </Col>
        <Col xs={12} lg={6}>
          <StatsCard title="Ideas" value={activeIdeas.length} icon={<BulbOutlined />} description={`/ ${ideas?.length ?? 0}`} />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="Active Goals" size="small">
            {activeGoals.length === 0 ? (
              <Empty description="暂无活跃 Goal" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {activeGoals.slice(0, 5).map(goal => {
                  const match = goal.progress?.match(/(\d+)\s*\/\s*(\d+)/);
                  const total = match ? parseInt(match[2], 10) : 0;
                  const pct = match && total > 0 ? Math.round((parseInt(match[1], 10) / total) * 100) : undefined;
                  return (
                    <Link key={goal.id} to={`/goals/${goal.id}`} style={{ display: 'block' }}>
                      <Card size="small" hoverable style={{ marginBottom: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text strong>{goal.name}</Text>
                          <Tag>{goal.type ?? '未分类'}</Tag>
                        </div>
                        {pct !== undefined && (
                          <Progress percent={pct} size="small" style={{ marginTop: 4, marginBottom: 0 }} />
                        )}
                      </Card>
                    </Link>
                  );
                })}
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card title="最近 DevLogs" size="small">
            {!devlogs || devlogs.length === 0 ? (
              <Empty description="暂无开发日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {devlogs.slice(0, 5).map(log => (
                  <Card size="small" key={log.id}>
                    <Text strong>{log.name}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {log.project} · {log.commits} commits · {formatDateTime(log.created_at)}
                    </Text>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
