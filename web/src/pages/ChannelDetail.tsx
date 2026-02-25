import { useState, useEffect, useMemo } from 'react';
import { useParams, Navigate, useSearchParams } from 'react-router';
import { Typography, Breadcrumb, Card, Descriptions, Spin, Space, Alert, Tabs, Tag, Table, Empty } from 'antd';
import { BranchesOutlined, FolderOutlined, ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { ChannelTree } from '@/components/channels/ChannelTree';
import ConversationViewer from '@/components/sessions/ConversationViewer';
import ChangesViewer from '@/components/ChangesViewer';
import { useChannel } from '@/lib/hooks/use-channels';
import { useChannelSessions, fetchSessionConversation } from '@/lib/hooks/use-sessions';
import { useChannelChanges, useChangesDetail } from '@/lib/hooks/use-changes';
import type { SessionSummary, SessionEvent } from '@/lib/hooks/use-sessions';
import type { SessionChangesSummary } from '@/lib/types';
import { formatDistanceToNow, formatDateTime } from '@/lib/format';
import { formatK } from '@/pages/Sessions';

const { Title, Text } = Typography;
const MAX_LOADED_SESSIONS = 5;

const statusColors: Record<string, string> = {
  active: 'green',
  closed: 'default',
  waiting: 'orange',
  idle: 'blue',
};

/** Session 列表 Tab：表格展示所有 session，含 cost/token */
function SessionListTab({ channelId }: { channelId: string }) {
  const { data: sessions, isLoading } = useChannelSessions(channelId);

  const sortedSessions = useMemo(() => {
    if (!sessions) return [];
    return [...sessions].sort((a, b) => b.created_at - a.created_at);
  }, [sessions]);

  const totalCost = useMemo(
    () => sortedSessions.reduce((sum, s) => sum + (s.cost_usd || 0), 0),
    [sortedSessions],
  );

  const columns = [
    {
      title: 'Title',
      key: 'title',
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
      width: 120,
      render: (ts: number | null, record: SessionSummary) =>
        formatDistanceToNow(ts || record.created_at),
    },
  ];

  return (
    <div>
      {totalCost > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary">总计 Cost: </Text>
          <Text strong>${totalCost.toFixed(2)}</Text>
          <Text type="secondary" style={{ marginLeft: 16 }}>
            Sessions: {sortedSessions.length}
          </Text>
        </div>
      )}
      <Table
        dataSource={sortedSessions}
        columns={columns}
        rowKey="claude_session_id"
        loading={isLoading}
        pagination={false}
        size="small"
        scroll={{ x: 'max-content' }}
      />
    </div>
  );
}

/** 会话内容 Tab：ConversationViewer */
function ConversationTab({ channelId }: { channelId: string }) {
  const { data: sessions, isLoading: sessionsLoading } = useChannelSessions(channelId);
  const [conversationMap, setConversationMap] = useState<Map<string, SessionEvent[]>>(new Map());
  const [loading, setLoading] = useState(false);

  const sortedSessions = useMemo(() => {
    if (!sessions) return [];
    return [...sessions].sort((a, b) => b.created_at - a.created_at);
  }, [sessions]);

  const recentSessions = sortedSessions.slice(0, MAX_LOADED_SESSIONS);
  const olderSessions = sortedSessions.slice(MAX_LOADED_SESSIONS);

  useEffect(() => {
    if (!sessions || sessions.length === 0) return;

    const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);
    const recent = sorted.slice(0, MAX_LOADED_SESSIONS);
    if (recent.length === 0) return;

    let cancelled = false;
    setLoading(true);

    const results: [string, SessionEvent[]][] = [];
    const queue = [...recent];
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length > 0) {
        const s = queue.shift()!;
        try {
          const events = await fetchSessionConversation(s.claude_session_id);
          results.push([s.claude_session_id, events]);
        } catch {
          results.push([s.claude_session_id, []]);
        }
      }
    });

    Promise.all(workers).then(() => {
      if (cancelled) return;
      const map = new Map<string, SessionEvent[]>();
      for (const [id, events] of results) {
        map.set(id, events);
      }
      setConversationMap(map);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [sessions]);

  if (sessionsLoading || loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!sessions || sessions.length === 0) {
    return <Alert message="暂无关联的 Claude Session" type="info" showIcon />;
  }

  return (
    <div>
      <ConversationViewer
        sessions={recentSessions}
        conversationMap={conversationMap}
      />
      {olderSessions.length > 0 && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: '#fafafa', borderRadius: 8 }}>
          <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
            更早的 {olderSessions.length} 个 Session
          </Text>
          {olderSessions.map(s => (
            <div key={s.claude_session_id} style={{
              padding: '6px 0',
              borderBottom: '1px solid #f0f0f0',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <Link to={`/sessions/${s.claude_session_id}`}>
                <Text code style={{ fontSize: 12 }}>{s.claude_session_id.slice(0, 8)}</Text>
              </Link>
              {s.model && <Text type="secondary" style={{ fontSize: 12 }}>{s.model}</Text>}
              <Tag style={{ fontSize: 11 }}>{s.status}</Tag>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {formatDateTime(s.created_at)}
              </Text>
              {s.cost_usd > 0 && (
                <Text style={{ fontSize: 11 }}>${s.cost_usd.toFixed(2)}</Text>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Changes Tab：展示每次 session 的文件变更 diff */
function ChangesTab({ channelId }: { channelId: string }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: changesPage, isLoading, error } = useChannelChanges(channelId);
  const { data: detail, isLoading: detailLoading } = useChangesDetail(selectedId);

  const items = changesPage?.items ?? [];

  // 默认选中第一条
  useEffect(() => {
    if (items.length > 0 && selectedId == null) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (items.length === 0) {
    return <Empty description="暂无文件变更记录" />;
  }

  const columns = [
    {
      title: '变更',
      key: 'fileCount',
      render: (_: unknown, record: SessionChangesSummary) => (
        <a onClick={() => setSelectedId(record.id)} style={{ cursor: 'pointer' }}>
          {record.fileCount} file{record.fileCount !== 1 ? 's' : ''}
        </a>
      ),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: number) => formatDateTime(ts),
    },
  ];

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 左侧列表 */}
      <div style={{ width: 220, flexShrink: 0 }}>
        <Table
          dataSource={items}
          columns={columns}
          rowKey="id"
          pagination={false}
          size="small"
          rowClassName={(record) => record.id === selectedId ? 'ant-table-row-selected' : ''}
          onRow={(record) => ({ onClick: () => setSelectedId(record.id) })}
        />
      </div>

      {/* 右侧 diff 视图 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin />
          </div>
        ) : detail ? (
          <ChangesViewer fileChanges={detail.fileChanges} />
        ) : (
          <Empty description="选择左侧记录查看 diff" />
        )}
      </div>
    </div>
  );
}

export default function ChannelDetail() {
  const { channelId } = useParams<{ channelId: string }>();
  const [searchParams] = useSearchParams();
  const { data: channel, error } = useChannel(channelId ?? null);

  if (!channelId) return <Navigate to="/channels" replace />;

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (!channel) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  const tabItems = [];

  if (channel.children?.length) {
    tabItems.push({
      key: 'children',
      label: `子 Channel (${channel.children.length})`,
      children: <ChannelTree channels={channel.children} />,
    });
  }

  tabItems.push({
    key: 'session-list',
    label: 'Sessions',
    children: <SessionListTab channelId={channelId} />,
  });

  tabItems.push({
    key: 'conversations',
    label: '会话内容',
    children: <ConversationTab channelId={channelId} />,
  });

  tabItems.push({
    key: 'changes',
    label: '文件变更',
    children: <ChangesTab channelId={channelId} />,
  });

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/channels">Channels</Link> },
        { title: channel.name },
      ]} />

      <Title level={3} style={{ margin: 0 }}>{channel.name}</Title>

      <Card title="Channel 信息" size="small">
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label={<><FolderOutlined /> 工作目录</>}>
            {channel.cwd}
          </Descriptions.Item>
          {channel.model && (
            <Descriptions.Item label={<><RobotOutlined /> 模型</>}>
              {channel.model}
            </Descriptions.Item>
          )}
          {channel.worktree_branch && (
            <Descriptions.Item label={<><BranchesOutlined /> 分支</>}>
              {channel.worktree_branch}
            </Descriptions.Item>
          )}
          <Descriptions.Item label={<><ClockCircleOutlined /> 创建时间</>}>
            {formatDistanceToNow(channel.created_at)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Tabs
        defaultActiveKey={searchParams.get('tab') ?? (channel.children?.length ? 'children' : 'session-list')}
        items={tabItems}
      />
    </Space>
  );
}
