import { useMemo, useState } from 'react';
import {
  Typography, Select, AutoComplete, Space, Empty, Spin, Row, Col, Alert,
  Button, Modal, Form, Input, message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { GoalCard } from '@/components/goals/GoalCard';
import { useGoals, createGoal } from '@/lib/hooks/use-goals';
import { useProjects } from '@/lib/hooks/use-projects';
import type { Goal, GoalStatus, GoalType } from '@/lib/types';

const { Title, Text } = Typography;
const { TextArea } = Input;

const statusOptions = [
  { value: 'all', label: '全部' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Collecting', label: 'Collecting' },
  { value: 'Planned', label: 'Planned' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Blocking', label: 'Blocking' },
  { value: 'Paused', label: 'Paused' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Merged', label: 'Merged' },
  { value: 'Failed', label: 'Failed' },
];

const goalStatusOptions: { value: GoalStatus; label: string }[] = [
  { value: 'Pending', label: 'Pending' },
  { value: 'Collecting', label: 'Collecting' },
  { value: 'Planned', label: 'Planned' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Blocking', label: 'Blocking' },
  { value: 'Paused', label: 'Paused' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Merged', label: 'Merged' },
  { value: 'Failed', label: 'Failed' },
];

const goalTypeOptions: { value: GoalType; label: string }[] = [
  { value: '探索型', label: '探索型' },
  { value: '交付型', label: '交付型' },
];

const UNGROUPED = '__ungrouped__';

function groupByProject(goals: Goal[]): { project: string; goals: Goal[] }[] {
  const map = new Map<string, Goal[]>();
  for (const goal of goals) {
    const key = goal.project || UNGROUPED;
    const list = map.get(key);
    if (list) list.push(goal);
    else map.set(key, [goal]);
  }
  const groups: { project: string; goals: Goal[] }[] = [];
  const keys = [...map.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    groups.push({ project: key, goals: map.get(key)! });
  }
  return groups;
}

interface GoalFormValues {
  name: string;
  status: GoalStatus;
  type?: GoalType;
  project?: string;
  completion?: string;
  body?: string;
}

export default function Goals() {
  const [statusFilter, setStatusFilter] = useState('all');
  const { data: goals, isLoading, error, mutate } = useGoals(
    statusFilter !== 'all' ? statusFilter : undefined
  );
  const { data: projectList } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<GoalFormValues>();

  const grouped = useMemo(() => goals ? groupByProject(goals) : [], [goals]);

  const openCreate = () => {
    form.setFieldsValue({ name: '', status: 'Pending', type: undefined, project: '', completion: '', body: '' });
    setModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await createGoal({
        name: values.name,
        status: values.status,
        type: values.type,
        project: values.project || undefined,
        completion: values.completion || undefined,
        body: values.body || undefined,
      });
      message.success('Goal 创建成功');
      setModalOpen(false);
      mutate();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Goals</Title>
          <Text type="secondary">开发目标管理</Text>
        </div>
        <Space>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            options={statusOptions}
            style={{ width: 140 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建
          </Button>
        </Space>
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !goals || goals.length === 0 ? (
        <Empty description="暂无 Goal" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {grouped.map(({ project, goals: projectGoals }) => (
            <div key={project}>
              <Title level={5} style={{ margin: '0 0 12px' }}>
                {project === UNGROUPED ? '未分类' : project}
                <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal', marginLeft: 8 }}>
                  {projectGoals.length}
                </Text>
              </Title>
              <Row gutter={[16, 16]}>
                {projectGoals.map(goal => (
                  <Col key={goal.id} xs={24} md={12} lg={8}>
                    <GoalCard goal={goal} />
                  </Col>
                ))}
              </Row>
            </div>
          ))}
        </Space>
      )}

      <Modal
        title="新建 Goal"
        open={modalOpen}
        onOk={handleCreate}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="Goal 名称" />
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
                <AutoComplete
                  options={(projectList ?? []).map(p => ({ value: p.name }))}
                  placeholder="所属项目"
                  filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="completion" label="完成标准">
            <Input placeholder="什么算完成？" />
          </Form.Item>
          <Form.Item name="body" label="详情">
            <TextArea rows={4} placeholder="Goal 详细描述（Markdown）" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
