import { useMemo, useState } from 'react';
import { useParams, Navigate } from 'react-router';
import { Typography, Breadcrumb, Tabs, Tag, Card, Space, Spin, Alert, Select } from 'antd';
import { Link } from 'react-router';
import { GoalDAG } from '@/components/goals/GoalDAG';
import { TaskPanel } from '@/components/goals/TaskPanel';
import { DriveControls } from '@/components/goals/DriveControls';
import { GoalStatusBadge, taskStatusLabels } from '@/components/goals/StatusBadge';
import { useGoal, useGoalDrive } from '@/lib/hooks/use-goals';
import type { GoalTaskStatus } from '@/lib/types';

const { Title, Text } = Typography;

export default function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { data: goal, error: goalError } = useGoal(goalId ?? null);
  const { data: drive, error: driveError, mutate: mutateDrive } = useGoalDrive(goalId ?? null);

  const [dagStatusFilter, setDagStatusFilter] = useState<GoalTaskStatus[]>([]);

  const tasks = drive?.tasks ?? [];

  const dagStatusOptions = useMemo(() => {
    if (!tasks.length) return [];
    const statuses = [...new Set(tasks.map(t => t.status))];
    return statuses.map(s => ({ value: s, label: taskStatusLabels[s] }));
  }, [tasks]);

  if (!goalId) return <Navigate to="/goals" replace />;

  if (goalError) {
    return <Alert message="加载失败" description={goalError.message} type="error" showIcon />;
  }

  if (!goal) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  const completed = tasks.filter(t => t.status === 'completed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const failed = tasks.filter(t => t.status === 'failed').length;

  const tabItems = [
    {
      key: 'dag',
      label: 'DAG 依赖图',
      children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Select
              mode="multiple"
              allowClear
              placeholder="按状态高亮"
              value={dagStatusFilter}
              onChange={setDagStatusFilter}
              options={dagStatusOptions}
              style={{ minWidth: 200 }}
              maxTagCount="responsive"
            />
          </div>
          <GoalDAG
            tasks={tasks}
            highlightStatuses={dagStatusFilter.length > 0 ? dagStatusFilter : undefined}
          />
        </Space>
      ),
    },
    {
      key: 'tasks',
      label: '任务列表',
      children: <TaskPanel goalId={goalId} tasks={tasks} onAction={() => mutateDrive()} />,
    },
    ...(goal.body ? [{
      key: 'detail',
      label: '详情',
      children: (
        <Card>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 14, margin: 0 }}>{goal.body}</pre>
        </Card>
      ),
    }] : []),
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/goals">Goals</Link> },
        { title: goal.name },
      ]} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={3} style={{ margin: 0 }}>{goal.name}</Title>
        <Space>
          <GoalStatusBadge status={goal.status} />
          {drive && <DriveControls goalId={goalId} status={drive.status} onAction={() => mutateDrive()} />}
        </Space>
      </div>

      <Space size="small">
        {goal.type && <Tag>{goal.type}</Tag>}
        {goal.project && <Tag>{goal.project}</Tag>}
        {goal.progress && (() => {
          const m = goal.progress!.match(/(\d+)\s*\/\s*(\d+)/);
          const text = goal.status === 'Done' && m ? `${m[2]}/${m[2]} 子任务完成` : goal.progress;
          return <Text type="secondary">{text}</Text>;
        })()}
      </Space>

      {driveError && (
        <Alert message="Drive 状态加载失败" description={driveError.message} type="warning" showIcon closable />
      )}

      {drive && tasks.length > 0 && (
        <Space size="large" style={{ fontSize: 14 }}>
          <span>共 {tasks.length} 个任务</span>
          <Text type="success">{completed} 完成</Text>
          {running > 0 && <Text style={{ color: '#1677ff' }}>{running} 运行中</Text>}
          {failed > 0 && <Text type="danger">{failed} 失败</Text>}
        </Space>
      )}

      <Tabs defaultActiveKey="dag" items={tabItems} />
    </Space>
  );
}
