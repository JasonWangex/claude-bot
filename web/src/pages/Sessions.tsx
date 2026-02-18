import { useState } from 'react';
import { Typography, Card, Table, Tag, Segmented, Space, Alert, Tooltip } from 'antd';
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

const purposeColors: Record<string, string> = {
  channel: 'blue',
  plan: 'purple',
  temp: 'default',
  replan: 'orange',
};

/** 渲染 Context 列：goal > channel > cwd */
function renderContext(record: SessionSummary) {
  if (record.goal_name) {
    const project = record.goal_project ? `[${record.goal_project}] ` : '';
    return (
      <Space direction="vertical" size={0}>
        <Text>{project}{record.goal_name}</Text>
        {record.channel_name && record.channel_id && (
          <Link to={`/tasks/${record.channel_id}`}>
            <Text type="secondary" style={{ fontSize: 12 }}>{record.channel_name}</Text>
          </Link>
        )}
      </Space>
    );
  }

  if (record.channel_name && record.channel_id) {
    return <Link to={`/tasks/${record.channel_id}`}>{record.channel_name}</Link>;
  }

  // 显示项目路径（优先 project_path，fallback cwd）
  const path = record.project_path || record.cwd;
  if (path) {
    const parts = path.split('/');
    const short = parts.slice(-2).join('/');
    return (
      <Tooltip title={path}>
        <Text type="secondary">{short}</Text>
      </Tooltip>
    );
  }

  return <Text type="secondary">-</Text>;
}

const columns = [
  {
    title: 'Title',
    key: 'title',
    ellipsis: true,
    render: (_: unknown, record: SessionSummary) => record.title
      ? record.title
      : <Text type="secondary">{record.claude_session_id?.slice(0, 8) || '-'}</Text>,
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
    title: 'Context',
    key: 'context',
    width: 240,
    render: (_: unknown, record: SessionSummary) => renderContext(record),
  },
  {
    title: 'Purpose',
    key: 'purpose',
    width: 90,
    render: (_: unknown, record: SessionSummary) => record.purpose
      ? <Tag color={purposeColors[record.purpose] || 'default'}>{record.purpose}</Tag>
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
    title: '最近活动',
    dataIndex: 'last_activity_at',
    key: 'last_activity_at',
    width: 160,
    defaultSortOrder: 'descend' as const,
    sorter: (a: SessionSummary, b: SessionSummary) =>
      (a.last_activity_at || a.created_at) - (b.last_activity_at || b.created_at),
    render: (ts: number | null, record: SessionSummary) => {
      const t = ts || record.created_at;
      return formatDistanceToNow(t);
    },
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
