import { useState } from 'react';
import { Typography, Card, Table, Tag, Segmented, Space, Alert } from 'antd';
import { Link } from 'react-router';
import { useSessions } from '@/lib/hooks/use-sessions';
import type { SessionSummary } from '@/lib/hooks/use-sessions';
import { formatDistanceToNow, formatDateTime } from '@/lib/format';

const { Title, Text } = Typography;

const statusColors: Record<string, string> = {
  active: 'green',
  closed: 'default',
  waiting: 'orange',
  idle: 'blue',
};

function formatDuration(createdAt: number, closedAt: number | null): string {
  const end = closedAt || Date.now();
  const diffMs = end - createdAt;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const columns = [
  {
    title: 'Title',
    key: 'title',
    ellipsis: true,
    render: (_: unknown, record: SessionSummary) => {
      const displayTitle = record.title || record.channel_name;
      return displayTitle
        ? <Link to={`/sessions/${record.id}`}>{displayTitle}</Link>
        : <Link to={`/sessions/${record.id}`}><Text type="secondary">{record.id.slice(0, 8)}...</Text></Link>;
    },
  },
  {
    title: 'Model',
    dataIndex: 'model',
    key: 'model',
    width: 160,
    render: (model: string | null) => model || <Text type="secondary">-</Text>,
  },
  {
    title: 'Status',
    dataIndex: 'status',
    key: 'status',
    width: 100,
    render: (status: string) => (
      <Tag color={statusColors[status] || 'default'}>{status}</Tag>
    ),
  },
  {
    title: 'Task',
    key: 'channel',
    width: 200,
    render: (_: unknown, record: SessionSummary) => record.channel_name
      ? <Link to={`/tasks/${record.channel_id}`}>{record.channel_name}</Link>
      : <Text type="secondary">-</Text>,
  },
  {
    title: '创建时间',
    dataIndex: 'created_at',
    key: 'created_at',
    width: 160,
    render: (ts: number) => formatDateTime(ts),
  },
  {
    title: '持续时长',
    key: 'duration',
    width: 100,
    render: (_: unknown, record: SessionSummary) => formatDuration(record.created_at, record.closed_at),
  },
  {
    title: '',
    key: 'action',
    width: 80,
    render: (_: unknown, record: SessionSummary) => (
      <Link to={`/sessions/${record.id}`}>详情</Link>
    ),
  },
];

export default function Sessions() {
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'closed'>('all');
  const { data: sessions, error, isLoading } = useSessions(statusFilter);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Sessions</Title>
          <Text type="secondary">Claude CLI 会话历史</Text>
        </div>
        <Segmented
          options={[
            { label: '全部', value: 'all' },
            { label: '活跃', value: 'active' },
            { label: '已关闭', value: 'closed' },
          ]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as 'all' | 'active' | 'closed')}
        />
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : (
        <Card>
          <Table
            dataSource={sessions || []}
            columns={columns}
            rowKey="id"
            loading={isLoading}
            pagination={{ pageSize: 50 }}
            size="small"
          />
        </Card>
      )}
    </Space>
  );
}
