import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router';
import { Typography, Breadcrumb, Card, Descriptions, Spin, Space, Alert, Tag } from 'antd';
import { ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import ConversationViewer from '@/components/sessions/ConversationViewer';
import { fetchSessionConversation } from '@/lib/hooks/use-sessions';
import type { SessionSummary, SessionEvent } from '@/lib/hooks/use-sessions';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

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
    id: sessionId,
    claude_session_id: null,
    channel_id: null,
    channel_name: null,
    model: null,
    status: 'unknown',
    purpose: null,
    created_at: 0,
    closed_at: null,
    last_activity_at: null,
  };

  const conversationMap = new Map<string, SessionEvent[]>();
  conversationMap.set(sessionId, events);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/sessions">Sessions</Link> },
        { title: session?.title || session?.channel_name || `Session ${sessionId.slice(0, 8)}...` },
      ]} />

      <Title level={3} style={{ margin: 0 }}>
        {session?.title || session?.channel_name || `Session ${sessionId.slice(0, 8)}...`}
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
            {session.channel_name && (
              <Descriptions.Item label="Task">
                <Link to={`/tasks/${session.channel_id}`}>{session.channel_name}</Link>
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
          </Descriptions>
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
