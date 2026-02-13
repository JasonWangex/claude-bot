import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { taskStatusLabels } from './StatusBadge';
import type { GoalTask, GoalTaskStatus } from '@/lib/types';

const statusStyles: Record<GoalTaskStatus, { border: string; bg: string; dot: string }> = {
  pending:          { border: '#d9d9d9', bg: '#fff',    dot: '#bfbfbf' },
  dispatched:       { border: '#b37feb', bg: '#f9f0ff', dot: '#722ed1' },
  running:          { border: '#1677ff', bg: '#e6f4ff', dot: '#1677ff' },
  completed:        { border: '#52c41a', bg: '#f6ffed', dot: '#52c41a' },
  failed:           { border: '#ff4d4f', bg: '#fff2f0', dot: '#ff4d4f' },
  blocked:          { border: '#fa8c16', bg: '#fff7e6', dot: '#fa8c16' },
  blocked_feedback: { border: '#faad14', bg: '#fffbe6', dot: '#faad14' },
  paused:           { border: '#fadb14', bg: '#fffbe6', dot: '#fadb14' },
  cancelled:        { border: '#d9d9d9', bg: '#fafafa', dot: '#bfbfbf' },
  skipped:          { border: '#d9d9d9', bg: '#fafafa', dot: '#bfbfbf' },
};

const TYPE_LABELS: Record<string, string> = {
  '代码': 'Code',
  '手动': 'Manual',
  '调研': 'Research',
  '占位': 'Placeholder',
};

type TaskNodeData = { task: GoalTask };

function TaskNodeComponent({ data }: { data: TaskNodeData }) {
  const { task } = data;
  const isRunning = task.status === 'running';
  const style = statusStyles[task.status];

  return (
    <div style={{
      borderRadius: 8,
      border: `2px solid ${style.border}`,
      background: style.bg,
      padding: '12px 16px',
      minWidth: 200,
      maxWidth: 280,
      boxShadow: isRunning ? `0 2px 8px ${style.border}40` : undefined,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#bfbfbf', width: 8, height: 8 }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#bfbfbf' }}>{task.id}</span>
        <span style={{ fontSize: 10, color: '#8c8c8c' }}>
          {TYPE_LABELS[task.type] ?? task.type}
        </span>
      </div>

      <p style={{
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.4,
        margin: '0 0 6px 0',
        color: '#262626',
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }}>
        {task.description}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: style.dot,
          animation: isRunning ? 'pulse 2s infinite' : undefined,
        }} />
        <span style={{ fontSize: 10, fontWeight: 500, color: '#595959' }}>
          {taskStatusLabels[task.status]}
        </span>
        {task.merged && (
          <span style={{ fontSize: 10, color: '#52c41a', marginLeft: 'auto' }}>merged</span>
        )}
      </div>

      {task.error && (
        <p style={{ fontSize: 10, color: '#ff4d4f', margin: '4px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.error}
        </p>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#bfbfbf', width: 8, height: 8 }} />
    </div>
  );
}

export const TaskNode = memo(TaskNodeComponent);
