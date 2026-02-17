import { useState } from 'react';
import { Typography, Space, Empty, Tag } from 'antd';
import { RightOutlined, DownOutlined, BranchesOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { formatDistanceToNow } from '@/lib/format';
import type { TaskSummary } from '@/lib/types';

const { Text } = Typography;

function TaskTreeNode({ task, depth = 0 }: { task: TaskSummary; depth?: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = (task.children?.length ?? 0) > 0;
  const isArchived = task.status === 'archived';

  return (
    <div>
      <div
        className="task-tree-node"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 6,
          marginLeft: depth * 24,
          transition: 'background 0.2s',
          opacity: isArchived ? 0.5 : 1,
        }}
      >
        {hasChildren ? (
          <span
            role="button"
            tabIndex={0}
            onClick={() => setExpanded(!expanded)}
            onKeyDown={e => e.key === 'Enter' && setExpanded(!expanded)}
            style={{ cursor: 'pointer', fontSize: 10, color: '#999' }}
          >
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </span>
        ) : (
          <span style={{ width: 14 }} />
        )}

        <Link to={`/tasks/${task.channel_id}`} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text strong style={{ fontSize: 14, color: isArchived ? '#999' : undefined }} ellipsis>{task.name}</Text>
              {isArchived && <Tag color="default">已归档</Tag>}
              {!isArchived && task.has_session && (
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#52c41a', flexShrink: 0 }} title="有活跃 Session" />
              )}
            </div>
            <Space size={12} style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
              {task.worktree_branch && (
                <span><BranchesOutlined /> {task.worktree_branch}</span>
              )}
              {task.model && <span>{task.model}</span>}
              {task.last_message_at && (
                <span><ClockCircleOutlined /> {formatDistanceToNow(task.last_message_at)}</span>
              )}
            </Space>
          </div>
        </Link>

        {task.last_message && (
          <Text type="secondary" style={{ fontSize: 12, maxWidth: 200, flexShrink: 0 }} ellipsis>
            {task.last_message.slice(0, 60)}
          </Text>
        )}
      </div>

      {expanded && hasChildren && (
        <div style={{ borderLeft: '1px solid #f0f0f0', marginLeft: 20 + depth * 24 }}>
          {task.children.map(child => (
            <TaskTreeNode key={child.channel_id} task={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskTree({ tasks }: { tasks: TaskSummary[] }) {
  if (tasks.length === 0) {
    return <Empty description="暂无 Task" />;
  }

  return (
    <div>
      {tasks.map(task => (
        <TaskTreeNode key={task.channel_id} task={task} />
      ))}
    </div>
  );
}
