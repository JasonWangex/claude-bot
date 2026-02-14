import { useMemo, useState } from 'react';
import { useParams, Navigate } from 'react-router';
import {
  Typography, Breadcrumb, Tabs, Tag, Card, Space, Spin, Alert, Select,
  Button, Modal, Form, Input, Row, Col, message,
} from 'antd';
import { Link } from 'react-router';
import { EditOutlined } from '@ant-design/icons';
import { GoalDAG } from '@/components/goals/GoalDAG';
import { TaskPanel } from '@/components/goals/TaskPanel';
import { DriveControls } from '@/components/goals/DriveControls';
import { GoalStatusBadge, taskStatusLabels } from '@/components/goals/StatusBadge';
import { useGoal, useGoalDrive, updateGoal } from '@/lib/hooks/use-goals';
import type { GoalStatus, GoalType, GoalTaskStatus } from '@/lib/types';

const { Title, Text } = Typography;
const { TextArea } = Input;

const goalStatusOptions: { value: GoalStatus; label: string }[] = [
  { value: 'Idea', label: 'Idea' },
  { value: 'Active', label: 'Active' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Paused', label: 'Paused' },
  { value: 'Done', label: 'Done' },
  { value: 'Abandoned', label: 'Abandoned' },
];

const goalTypeOptions: { value: GoalType; label: string }[] = [
  { value: '探索型', label: '探索型' },
  { value: '交付型', label: '交付型' },
];

interface GoalEditFormValues {
  name: string;
  status: GoalStatus;
  type?: GoalType;
  project?: string;
  completion?: string;
  progress?: string;
  next?: string;
  blocked_by?: string;
  body?: string;
}

export default function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { data: goal, error: goalError, mutate: mutateGoal } = useGoal(goalId ?? null);
  const { data: drive, error: driveError, mutate: mutateDrive } = useGoalDrive(goalId ?? null);

  const [dagStatusFilter, setDagStatusFilter] = useState<GoalTaskStatus[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<GoalEditFormValues>();

  const tasks = drive?.tasks ?? [];

  const dagStatusOptions = useMemo(() => {
    if (!tasks.length) return [];
    const statuses = [...new Set(tasks.map(t => t.status))];
    return statuses.map(s => ({ value: s, label: taskStatusLabels[s] }));
  }, [tasks]);

  const openEdit = () => {
    if (!goal) return;
    form.setFieldsValue({
      name: goal.name,
      status: goal.status,
      type: goal.type ?? undefined,
      project: goal.project ?? '',
      completion: goal.completion ?? '',
      progress: goal.progress ?? '',
      next: goal.next ?? '',
      blocked_by: goal.blocked_by ?? '',
      body: goal.body ?? '',
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!goalId) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await updateGoal(goalId, {
        name: values.name,
        status: values.status,
        type: values.type,
        project: values.project || undefined,
        completion: values.completion || undefined,
        progress: values.progress || undefined,
        next: values.next || undefined,
        blocked_by: values.blocked_by || undefined,
        body: values.body || undefined,
      });
      message.success('Goal 更新成功');
      setEditOpen(false);
      mutateGoal();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || '更新失败');
    } finally {
      setSubmitting(false);
    }
  };

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
          <Button icon={<EditOutlined />} onClick={openEdit}>编辑</Button>
          <GoalStatusBadge status={goal.status} />
          {drive && <DriveControls goalId={goalId} status={drive.status} onAction={() => mutateDrive()} />}
        </Space>
      </div>

      <Space size="small">
        {goal.type && <Tag>{goal.type}</Tag>}
        {goal.project && <Tag>{goal.project}</Tag>}
        {goal.progress && (() => {
          const m = goal.progress!.match(/(\d+)\s*\/\s*(\d+)/);
          const text = (goal.status === 'Completed' || goal.status === 'Merged') && m ? `${m[2]}/${m[2]} 子任务完成` : goal.progress;
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

      <Modal
        title="编辑 Goal"
        open={editOpen}
        onOk={handleEdit}
        onCancel={() => setEditOpen(false)}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select options={goalStatusOptions} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="type" label="类型">
                <Select options={goalTypeOptions} allowClear placeholder="选择类型" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="project" label="项目">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="completion" label="完成标准">
            <Input />
          </Form.Item>
          <Form.Item name="progress" label="进度">
            <Input placeholder="如: 3/5" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="next" label="下一步">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="blocked_by" label="卡点">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="body" label="详情">
            <TextArea rows={6} placeholder="Markdown 格式" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
