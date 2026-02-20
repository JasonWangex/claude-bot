import { useState, useMemo } from 'react';
import { Typography, Card, Table, Tag, Segmented, Space, Alert, Tooltip, Dropdown, Button } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
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

/** 格式化数字为 k 单位 */
export function formatK(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + 'k';
}

/** 渲染 Context 列：goal > channel > cwd */
function renderContext(record: SessionSummary) {
  if (record.goal_name) {
    return (
      <Space direction="vertical" size={0}>
        {record.channel_name && record.channel_id && (
          <Link to={`/channels/${record.channel_id}`}>
            <Text style={{ fontSize: 12 }}>{record.channel_name}</Text>
          </Link>
        )}
        <span style={{ fontSize: 12 }}>
          <Text type="secondary">from: </Text>
          <Link to={`/goals/${record.goal_id}`}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.goal_project ? `[${record.goal_project}] ` : ''}{record.goal_name}
            </Text>
          </Link>
        </span>
      </Space>
    );
  }

  if (record.channel_name && record.channel_id) {
    return <Link to={`/channels/${record.channel_id}`}>{record.channel_name}</Link>;
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

const STORAGE_KEY = 'sessions-hidden-columns';

function loadHiddenColumns(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** 所有可选列定义 */
const allColumns = [
  {
    title: 'Title',
    key: 'title',
    fixed: 'left' as const,
    width: 240,
    ellipsis: true,
    render: (_: unknown, record: SessionSummary) => {
      const label = record.title || record.claude_session_id?.slice(0, 8) || '-';
      return (
        <Link to={`/sessions/${record.claude_session_id}`}>
          {record.title ? label : <Text type="secondary">{label}</Text>}
        </Link>
      );
    },
  },
  {
    title: 'Model',
    dataIndex: 'model',
    key: 'model',
    width: 130,
    render: (model: string | null) => model || <Text type="secondary">-</Text>,
  },
  {
    title: 'Status',
    dataIndex: 'status',
    key: 'status',
    width: 80,
    render: (status: string) => (
      <Tag color={statusColors[status] || 'default'}>{status}</Tag>
    ),
  },
  {
    title: 'Context',
    key: 'context',
    width: 260,
    render: (_: unknown, record: SessionSummary) => renderContext(record),
  },
  {
    title: 'Purpose',
    key: 'purpose',
    width: 80,
    render: (_: unknown, record: SessionSummary) => record.purpose
      ? <Tag color={purposeColors[record.purpose] || 'default'}>{record.purpose}</Tag>
      : <Text type="secondary">-</Text>,
  },
  {
    title: 'Cost',
    key: 'cost',
    width: 80,
    align: 'right' as const,
    render: (_: unknown, record: SessionSummary) =>
      record.cost_usd
        ? <Text>${record.cost_usd.toFixed(2)}</Text>
        : <Text type="secondary">-</Text>,
  },
  {
    title: 'In',
    key: 'tokens_in',
    width: 70,
    align: 'right' as const,
    render: (_: unknown, record: SessionSummary) => (
      <Text type="secondary">{formatK(record.tokens_in)}</Text>
    ),
  },
  {
    title: 'Out',
    key: 'tokens_out',
    width: 70,
    align: 'right' as const,
    render: (_: unknown, record: SessionSummary) => (
      <Text type="secondary">{formatK(record.tokens_out)}</Text>
    ),
  },
  {
    title: 'Cache R',
    key: 'cache_read_in',
    width: 80,
    align: 'right' as const,
    render: (_: unknown, record: SessionSummary) => (
      <Text type="secondary">{formatK(record.cache_read_in)}</Text>
    ),
  },
  {
    title: 'Cache W',
    key: 'cache_write_in',
    width: 80,
    align: 'right' as const,
    render: (_: unknown, record: SessionSummary) => (
      <Text type="secondary">{formatK(record.cache_write_in)}</Text>
    ),
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
    width: 140,
    defaultSortOrder: 'descend' as const,
    sorter: (a: SessionSummary, b: SessionSummary) =>
      (a.last_activity_at || a.created_at) - (b.last_activity_at || b.created_at),
    render: (ts: number | null, record: SessionSummary) => {
      const t = ts || record.created_at;
      return formatDistanceToNow(t);
    },
  },
];

/** 不允许隐藏的列 */
const FIXED_KEYS = new Set(['title']);

export default function Sessions() {
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'closed'>('all');
  const { data: sessions, error, isLoading } = useSessions(statusFilter);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(loadHiddenColumns);

  const toggleColumn = (key: string) => {
    setHiddenKeys(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const visibleColumns = useMemo(
    () => allColumns.filter(c => !hiddenKeys.includes(c.key)),
    [hiddenKeys],
  );

  const columnMenuItems = allColumns
    .filter(c => !FIXED_KEYS.has(c.key))
    .map(c => ({
      key: c.key,
      label: (
        <span>
          <span style={{ display: 'inline-block', width: 16, textAlign: 'center', marginRight: 4 }}>
            {hiddenKeys.includes(c.key) ? '' : '✓'}
          </span>
          {c.title as string}
        </span>
      ),
    }));

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Sessions</Title>
          <Text type="secondary">Claude CLI 会话历史</Text>
        </div>
        <Space>
          <Dropdown
            menu={{ items: columnMenuItems, onClick: ({ key }) => toggleColumn(key) }}
            trigger={['click']}
          >
            <Button size="small" icon={<SettingOutlined />}>列</Button>
          </Dropdown>
          <Segmented
            options={[
              { label: '全部', value: 'all' },
              { label: '活跃', value: 'active' },
              { label: '已关闭', value: 'closed' },
            ]}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as 'all' | 'active' | 'closed')}
          />
        </Space>
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : (
        <Card>
          <Table
            dataSource={sessions || []}
            columns={visibleColumns}
            rowKey="claude_session_id"
            loading={isLoading}
            pagination={{ pageSize: 50 }}
            size="small"
            scroll={{ x: 'max-content' }}
          />
        </Card>
      )}
    </Space>
  );
}
