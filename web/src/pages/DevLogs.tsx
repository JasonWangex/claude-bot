import { useMemo, useState } from 'react';
import { Typography, Timeline, Tag, Card, Spin, Empty, Space, Alert, Select } from 'antd';
import { BranchesOutlined, CodeOutlined } from '@ant-design/icons';
import { useDevLogs } from '@/lib/hooks/use-devlogs';
import { formatDateTime } from '@/lib/format';

const { Title, Text } = Typography;

export default function DevLogs() {
  const { data: devlogs, isLoading, error } = useDevLogs();
  const [projectFilter, setProjectFilter] = useState<string>('all');

  const projectOptions = useMemo(() => {
    if (!devlogs) return [{ value: 'all', label: '全部项目' }];
    const projects = [...new Set(devlogs.map(l => l.project).filter(Boolean))].sort();
    return [
      { value: 'all', label: '全部项目' },
      ...projects.map(p => ({ value: p, label: p })),
    ];
  }, [devlogs]);

  const filtered = useMemo(() => {
    if (!devlogs || projectFilter === 'all') return devlogs;
    return devlogs.filter(l => l.project === projectFilter);
  }, [devlogs, projectFilter]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>DevLogs</Title>
          <Text type="secondary">开发日志时间线</Text>
        </div>
        <Select
          value={projectFilter}
          onChange={setProjectFilter}
          options={projectOptions}
          style={{ width: 160 }}
        />
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !filtered || filtered.length === 0 ? (
        <Empty description="暂无开发日志" />
      ) : (
        <Timeline
          items={filtered.map(log => ({
            key: log.id,
            children: (
              <Card size="small">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text strong>{log.name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{formatDateTime(log.created_at)}</Text>
                </div>
                <Space size={4} style={{ marginBottom: 4 }}>
                  <Tag color="blue">{log.project}</Tag>
                  {log.goal && <Tag>{log.goal}</Tag>}
                </Space>
                <div style={{ fontSize: 14, color: '#595959', marginBottom: 4 }}>{log.summary}</div>
                <Space size={16} style={{ fontSize: 12, color: '#999' }}>
                  <span><BranchesOutlined /> {log.branch}</span>
                  <span>{log.commits} commits</span>
                  <span><CodeOutlined /> {log.lines_changed}</span>
                </Space>
              </Card>
            ),
          }))}
        />
      )}
    </Space>
  );
}
