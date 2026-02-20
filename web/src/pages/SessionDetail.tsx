import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router';
import { Typography, Breadcrumb, Card, Descriptions, Spin, Space, Alert, Tag, Table } from 'antd';
import { ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import ConversationViewer from '@/components/sessions/ConversationViewer';
import { fetchSessionConversation } from '@/lib/hooks/use-sessions';
import type { SessionSummary, SessionEvent } from '@/lib/hooks/use-sessions';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatK } from '@/pages/Sessions';

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

export default function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // Fetch session metadata
        const meta = await apiFetch<SessionSummary>(`/api/sessions/${sessionId}/meta`);
        if (!cancelled) setSession(meta);

        // Fetch conversation
        const conv = await fetchSessionConversation(sessionId);
        if (!cancelled) {
          setEvents(conv);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId]);

  if (!sessionId) return <Navigate to="/sessions" replace />;

  if (error) {
    return <Alert message="加载失败" description={error} type="error" showIcon />;
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  const sessionForViewer: SessionSummary = session || {
    claude_session_id: sessionId,
    channel_id: null,
    channel_name: null,
    model: null,
    status: 'unknown',
    purpose: null,
    title: null,
    created_at: 0,
    closed_at: null,
    last_activity_at: null,
    task_id: null,
    goal_id: null,
    task_description: null,
    pipeline_phase: null,
    goal_name: null,
    goal_project: null,
    cwd: null,
    git_branch: null,
    project_path: null,
    tokens_in: 0,
    tokens_out: 0,
    cache_read_in: 0,
    cache_write_in: 0,
    cost_usd: 0,
    turn_count: 0,
    model_usage: {},
  };

  const conversationMap = new Map<string, SessionEvent[]>();
  conversationMap.set(sessionId, events);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/sessions">Sessions</Link> },
        { title: `Session ${sessionId.slice(0, 8)}...` },
      ]} />

      <Title level={3} style={{ margin: 0 }}>
        Session {sessionId.slice(0, 8)}...
      </Title>

      {session && (
        <Card title="Session 信息" size="small">
          <Descriptions column={{ xs: 1, sm: 2 }} size="small">
            <Descriptions.Item label="Status">
              <Tag color={statusColors[session.status] || 'default'}>{session.status}</Tag>
            </Descriptions.Item>
            {session.model && (
              <Descriptions.Item label={<><RobotOutlined /> 模型</>}>
                {session.model}
              </Descriptions.Item>
            )}
            {session.goal_name && (
              <Descriptions.Item label="Goal">
                {session.goal_project && <Tag>{session.goal_project}</Tag>}
                {session.goal_name}
              </Descriptions.Item>
            )}
            {session.channel_name && (
              <Descriptions.Item label="Channel">
                <Link to={`/channels/${session.channel_id}`}>{session.channel_name}</Link>
                {session.pipeline_phase && (
                  <Tag style={{ marginLeft: 8 }}>{session.pipeline_phase}</Tag>
                )}
              </Descriptions.Item>
            )}
            {(session.project_path || session.cwd) && (
              <Descriptions.Item label="项目路径">
                <Text copyable style={{ fontSize: 12 }}>{session.project_path || session.cwd}</Text>
              </Descriptions.Item>
            )}
            {session.git_branch && (
              <Descriptions.Item label="Branch">
                <Tag>{session.git_branch}</Tag>
              </Descriptions.Item>
            )}
            <Descriptions.Item label={<><ClockCircleOutlined /> 创建时间</>}>
              {formatDateTime(session.created_at)}
            </Descriptions.Item>
            <Descriptions.Item label="持续时长">
              {formatDuration(session.created_at, session.closed_at)}
            </Descriptions.Item>
            {session.purpose && (
              <Descriptions.Item label="Purpose">
                {session.purpose}
              </Descriptions.Item>
            )}
            {(session.cost_usd > 0 || session.tokens_in > 0) && (
              <>
                <Descriptions.Item label="Cost">
                  ${session.cost_usd.toFixed(4)}
                </Descriptions.Item>
                <Descriptions.Item label="Tokens In">
                  {formatK(session.tokens_in)}
                </Descriptions.Item>
                <Descriptions.Item label="Tokens Out">
                  {formatK(session.tokens_out)}
                </Descriptions.Item>
                <Descriptions.Item label="Cache Read">
                  {formatK(session.cache_read_in)}
                </Descriptions.Item>
                <Descriptions.Item label="Cache Write">
                  {formatK(session.cache_write_in)}
                </Descriptions.Item>
                <Descriptions.Item label="Turns">
                  {session.turn_count}
                </Descriptions.Item>
              </>
            )}
          </Descriptions>

          {session.model_usage && Object.keys(session.model_usage).length > 1 && (
            <div style={{ marginTop: 16 }}>
              <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
                Per-model breakdown
              </Text>
              <Table
                size="small"
                pagination={false}
                dataSource={Object.entries(session.model_usage).map(([model, s]) => ({
                  key: model,
                  model,
                  cost: `$${s.costUsd.toFixed(4)}`,
                  tokensIn: formatK(s.tokensIn),
                  tokensOut: formatK(s.tokensOut),
                  cacheRead: formatK(s.cacheReadIn),
                  turns: s.turnCount,
                }))}
                columns={[
                  { title: 'Model', dataIndex: 'model', key: 'model', render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                  { title: 'Cost', dataIndex: 'cost', key: 'cost' },
                  { title: 'Tokens In', dataIndex: 'tokensIn', key: 'tokensIn' },
                  { title: 'Tokens Out', dataIndex: 'tokensOut', key: 'tokensOut' },
                  { title: 'Cache Read', dataIndex: 'cacheRead', key: 'cacheRead' },
                  { title: 'Turns', dataIndex: 'turns', key: 'turns' },
                ]}
              />
            </div>
          )}
        </Card>
      )}

      <Card title="会话内容">
        <ConversationViewer
          sessions={[sessionForViewer]}
          conversationMap={conversationMap}
          singleSession
        />
      </Card>
    </Space>
  );
}
