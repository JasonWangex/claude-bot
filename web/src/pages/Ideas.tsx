import { Typography, Card, Tag, Spin, Empty, Space, Row, Col, Alert } from 'antd';
import { useIdeas } from '@/lib/hooks/use-ideas';
import type { IdeaStatus } from '@/lib/types';

const { Title, Text } = Typography;

const statusColors: Record<IdeaStatus, string> = {
  'Idea': 'default',
  'Processing': 'processing',
  'Active': 'success',
  'Paused': 'warning',
  'Done': 'green',
  'Dropped': 'error',
};

const statusOrder: IdeaStatus[] = ['Idea', 'Processing', 'Active', 'Paused', 'Done', 'Dropped'];

export default function Ideas() {
  const { data: ideas, isLoading, error } = useIdeas();

  // Group by status
  const grouped = new Map<IdeaStatus, typeof ideas>();
  if (ideas) {
    for (const idea of ideas) {
      if (!grouped.has(idea.status)) grouped.set(idea.status, []);
      grouped.get(idea.status)!.push(idea);
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ margin: 0 }}>Ideas</Title>
        <Text type="secondary">想法管理</Text>
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !ideas || ideas.length === 0 ? (
        <Empty description="暂无想法记录" />
      ) : (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {statusOrder.map(status => {
            const items = grouped.get(status);
            if (!items || items.length === 0) return null;
            return (
              <div key={status}>
                <Space size={8} style={{ marginBottom: 12 }}>
                  <Tag color={statusColors[status]}>{status}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>({items.length})</Text>
                </Space>
                <Row gutter={[12, 12]}>
                  {items.map(idea => (
                    <Col key={idea.id} xs={24} md={12} lg={8}>
                      <Card size="small" hoverable>
                        <Text strong>{idea.name}</Text>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999', marginTop: 8 }}>
                          <span>{idea.project}</span>
                          <span>{idea.date}</span>
                        </div>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </div>
            );
          })}
        </Space>
      )}
    </Space>
  );
}
