import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router';
import { Typography, Breadcrumb, Card, Descriptions, Spin, Space, Alert, Tabs } from 'antd';
import { BranchesOutlined, FolderOutlined, ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { TaskTree } from '@/components/tasks/TaskTree';
import ConversationViewer from '@/components/sessions/ConversationViewer';
import { useTask } from '@/lib/hooks/use-tasks';
import { useTaskSessions, fetchSessionConversation } from '@/lib/hooks/use-sessions';
import type { SessionEvent } from '@/lib/hooks/use-sessions';
import { formatDistanceToNow } from '@/lib/format';

const { Title } = Typography;

function SessionsTab({ channelId }: { channelId: string }) {
  const { data: sessions, isLoading: sessionsLoading } = useTaskSessions(channelId);
  const [conversationMap, setConversationMap] = useState<Map<string, SessionEvent[]>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessions || sessions.length === 0) return;

    let cancelled = false;
    setLoading(true);

    // Concurrency-limited fetch (max 3 parallel)
    const results: [string, SessionEvent[]][] = [];
    const queue = [...sessions];
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length > 0) {
        const s = queue.shift()!;
        try {
          const events = await fetchSessionConversation(s.id);
          results.push([s.id, events]);
        } catch {
          results.push([s.id, []]);
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
    <ConversationViewer
      sessions={sessions}
      conversationMap={conversationMap}
    />
  );
}

export default function TaskDetail() {
  const { channelId } = useParams<{ channelId: string }>();
  const { data: task, error } = useTask(channelId ?? null);

  if (!channelId) return <Navigate to="/tasks" replace />;

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (!task) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  const tabItems = [];

  if (task.children?.length) {
    tabItems.push({
      key: 'children',
      label: `子任务 (${task.children.length})`,
      children: <TaskTree tasks={task.children} />,
    });
  }

  tabItems.push({
    key: 'sessions',
    label: '会话历史',
    children: <SessionsTab channelId={channelId} />,
  });

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/tasks">Tasks</Link> },
        { title: task.name },
      ]} />

      <Title level={3} style={{ margin: 0 }}>{task.name}</Title>

      <Card title="Session 信息" size="small">
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label={<><FolderOutlined /> 工作目录</>}>
            {task.cwd}
          </Descriptions.Item>
          {task.model && (
            <Descriptions.Item label={<><RobotOutlined /> 模型</>}>
              {task.model}
            </Descriptions.Item>
          )}
          {task.worktree_branch && (
            <Descriptions.Item label={<><BranchesOutlined /> 分支</>}>
              {task.worktree_branch}
            </Descriptions.Item>
          )}
          <Descriptions.Item label={<><ClockCircleOutlined /> 创建时间</>}>
            {formatDistanceToNow(task.created_at)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Tabs defaultActiveKey={task.children?.length ? 'children' : 'sessions'} items={tabItems} />
    </Space>
  );
}
