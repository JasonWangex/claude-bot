import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Tooltip } from 'antd';
import { taskStatusLabels } from './StatusBadge';
import type { GoalTask, GoalTaskStatus } from '@/lib/types';

const statusStyles: Record<GoalTaskStatus, { border: string; bg: string; dot: string }> = {
  pending:          { border: '#d9d9d9', bg: '#fff',    dot: '#bfbfbf' },
  dispatched:       { border: '#b37feb', bg: '#f9f0ff', dot: '#722ed1' },
  running:          { border: '#1677ff', bg: '#e6f4ff', dot: '#1677ff' },
  completed:        { border: '#52c41a', bg: '#f6ffed', dot: '#52c41a' },
  failed:           { border: '#ff4d4f', bg: '#fff2f0', dot: '#ff4d4f' },
  blocked:          { border: '#fa8c16', bg: '#fff7e6', dot: '#fa8c16' },
  blocked_feedback: { border: '#eb2f96', bg: '#fff0f6', dot: '#eb2f96' },
  paused:           { border: '#fadb14', bg: '#fffbe6', dot: '#fadb14' },
  cancelled:        { border: '#bfbfbf', bg: '#f5f5f5', dot: '#8c8c8c' },
  skipped:          { border: '#d9d9d9', bg: '#fafafa', dot: '#bfbfbf' },
};

const TYPE_LABELS: Record<string, string> = {
  '代码': 'Code',
  '手动': 'Manual',
  '调研': 'Research',
  '占位': 'Placeholder',
};

type TaskNodeData = { task: GoalTask; dimmed?: boolean };

function TaskNodeComponent({ data }: { data: TaskNodeData }) {
  const { task, dimmed } = data;
  const isRunning = task.status === 'running';
  const style = statusStyles[task.status];

  return (
    <div style={{
      borderRadius: 8,
      border: `2px solid ${style.border}`,
      background: style.bg,
      padding: '12px 16px',
      minWidth: 220,
      maxWidth: 300,
      boxShadow: isRunning ? `0 2px 8px ${style.border}40` : undefined,
      opacity: dimmed ? 0.2 : 1,
      transition: 'opacity 0.2s',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#bfbfbf', width: 8, height: 8 }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#bfbfbf' }}>{task.id}</span>
        <span style={{ fontSize: 11, color: '#8c8c8c' }}>
          {TYPE_LABELS[task.type] ?? task.type}
        </span>
      </div>

      <Tooltip title={task.description} mouseEnterDelay={0.4}>
        <p style={{
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1.4,
          margin: '0 0 6px 0',
          color: '#262626',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          cursor: 'default',
        }}>
          {task.description}
        </p>
      </Tooltip>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: style.dot,
          animation: isRunning ? 'pulse 2s infinite' : undefined,
        }} />
        <span style={{ fontSize: 11, fontWeight: 500, color: '#595959' }}>
          {taskStatusLabels[task.status]}
        </span>
        {task.merged && (
          <span style={{ fontSize: 11, color: '#52c41a', marginLeft: 'auto' }}>merged</span>
        )}
      </div>

      {task.error && (
        <Tooltip title={task.error}>
          <p style={{ fontSize: 11, color: '#ff4d4f', margin: '4px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' }}>
            {task.error}
          </p>
        </Tooltip>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#bfbfbf', width: 8, height: 8 }} />
    </div>
  );
}

export const TaskNode = memo(TaskNodeComponent);
