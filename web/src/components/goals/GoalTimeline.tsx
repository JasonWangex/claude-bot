import { Timeline, Typography, Empty, Spin, Alert } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { GoalTimelineEvent, GoalTimelineEventType } from '@/lib/types';
import { useGoalTimeline } from '@/lib/hooks/use-goals';

const { Text } = Typography;

const typeConfig: Record<GoalTimelineEventType, { color: string; icon: React.ReactNode }> = {
  success: { color: 'green',  icon: <CheckCircleOutlined /> },
  error:   { color: 'red',    icon: <CloseCircleOutlined /> },
  warning: { color: 'orange', icon: <ExclamationCircleOutlined /> },
  info:    { color: 'blue',   icon: <InfoCircleOutlined /> },
  pipeline:{ color: 'gray',   icon: <ThunderboltOutlined /> },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** 去除 Discord Markdown 符号，保留纯文本 */
function stripDiscordMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/__(.+?)__/g, '$1')        // __underline__
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1') // `code` / ```code```
    .replace(/\[(.+?)\]\(.+?\)/g, '$1'); // [text](url)
}

interface GoalTimelineProps {
  goalId: string;
}

export function GoalTimeline({ goalId }: GoalTimelineProps) {
  const { data: events, error, isLoading } = useGoalTimeline(goalId);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return <Alert message="Timeline 加载失败" description={error.message} type="error" showIcon />;
  }

  if (!events || events.length === 0) {
    return <Empty description="暂无 Timeline 记录，启动 Drive 后自动记录关键事件" />;
  }

  const items = events.map((ev: GoalTimelineEvent) => {
    const cfg = typeConfig[ev.type] ?? typeConfig.info;
    return {
      key: ev.id,
      color: cfg.color,
      dot: cfg.icon,
      children: (
        <div style={{ marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
            {formatTime(ev.createdAt)}
          </Text>
          <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14 }}>
            {stripDiscordMarkdown(ev.message)}
          </Text>
        </div>
      ),
    };
  });

  return (
    <div style={{ padding: '8px 0' }}>
      <Timeline mode="left" items={items} />
    </div>
  );
}
