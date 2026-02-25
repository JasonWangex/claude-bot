import { useMemo, useState } from 'react';
import {
  Typography, Timeline, Tag, Card, Spin, Empty, Space, Alert, Select, AutoComplete,
  Button, Modal, Form, Input, InputNumber, message,
} from 'antd';
import { BranchesOutlined, CodeOutlined, PlusOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { useDevLogs, createDevLog } from '@/lib/hooks/use-devlogs';
import { useProjects } from '@/lib/hooks/use-projects';
import { formatDateTime } from '@/lib/format';
import { getProjectColor } from '@/lib/project-colors';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface DevLogFormValues {
  name: string;
  date: string;
  project: string;
  branch?: string;
  summary?: string;
  commits?: number;
  lines_changed?: string;
  goal?: string;
  content?: string;
}

export default function DevLogs() {
  const { data: devlogs, isLoading, error, mutate } = useDevLogs();
  const { data: projectList } = useProjects();
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<DevLogFormValues>();

  const projectOptions = useMemo(() => {
    const fromData = devlogs ? devlogs.map(l => l.project).filter(Boolean) : [];
    const fromFs = (projectList ?? []).map(p => p.name);
    const all = [...new Set([...fromData, ...fromFs])].sort();
    return [
      { value: 'all', label: '全部项目' },
      ...all.map(p => ({ value: p, label: p })),
    ];
  }, [devlogs, projectList]);

  const filtered = useMemo(() => {
    if (!devlogs || projectFilter === 'all') return devlogs;
    return devlogs.filter(l => l.project === projectFilter);
  }, [devlogs, projectFilter]);

  const openCreate = () => {
    form.setFieldsValue({
      name: '',
      date: new Date().toISOString().slice(0, 10),
      project: '',
      branch: '',
      summary: '',
      commits: 0,
      lines_changed: '',
      goal: '',
      content: '',
    });
    setModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await createDevLog({
        name: values.name,
        date: values.date,
        project: values.project,
        branch: values.branch || undefined,
        summary: values.summary || undefined,
        commits: values.commits ?? undefined,
        lines_changed: values.lines_changed || undefined,
        goal: values.goal || undefined,
        content: values.content || undefined,
      });
      message.success('DevLog 创建成功');
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
          <Title level={3} style={{ margin: 0 }}>DevLogs</Title>
          <Text type="secondary">开发日志时间线</Text>
        </div>
        <Space>
          <Select
            value={projectFilter}
            onChange={setProjectFilter}
            options={projectOptions}
            style={{ width: 160 }}
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
      ) : !filtered || filtered.length === 0 ? (
        <Empty description="暂无开发日志" />
      ) : (
        <Timeline
          items={filtered.map(log => ({
            key: log.id,
            children: (
              <Link to={`/devlogs/${log.id}`} style={{ display: 'block', color: 'inherit' }}>
                <Card size="small" hoverable>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text strong>{log.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{formatDateTime(log.created_at)}</Text>
                  </div>
                  <Space size={4} style={{ marginBottom: 4 }}>
                    <Tag color={getProjectColor(log.project)}>{log.project}</Tag>
                    {log.goal && <Tag>{log.goal}</Tag>}
                  </Space>
                  <div style={{ fontSize: 14, color: '#595959', marginBottom: 4 }}>{log.summary}</div>
                  <Space size={16} style={{ fontSize: 12, color: '#999' }}>
                    <span><BranchesOutlined /> {log.branch}</span>
                    <span>{log.commits} commits</span>
                    <span><CodeOutlined /> {log.lines_changed}</span>
                  </Space>
                </Card>
              </Link>
            ),
          }))}
        />
      )}

      <Modal
        title="新建 DevLog"
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
            <Input placeholder="DevLog 名称" />
          </Form.Item>
          <Form.Item
            name="date"
            label="日期"
            rules={[
              { required: true, message: '请输入日期' },
              { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '格式: yyyy-MM-dd' },
            ]}
          >
            <Input placeholder="yyyy-MM-dd" />
          </Form.Item>
          <Form.Item name="project" label="项目" rules={[{ required: true, message: '请输入项目名' }]}>
            <AutoComplete
              options={(projectList ?? []).map(p => ({ value: p.name }))}
              placeholder="所属项目"
              filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="branch" label="分支">
            <Input placeholder="Git 分支名" />
          </Form.Item>
          <Form.Item name="summary" label="摘要">
            <TextArea rows={2} placeholder="本次开发摘要" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="commits" label="Commits">
              <InputNumber min={0} placeholder="0" />
            </Form.Item>
            <Form.Item name="lines_changed" label="代码变更">
              <Input placeholder="+100 -50" />
            </Form.Item>
          </Space>
          <Form.Item name="goal" label="关联 Goal">
            <Input placeholder="关联的 Goal（可选）" />
          </Form.Item>
          <Form.Item name="content" label="内容">
            <TextArea rows={4} placeholder="详细内容（Markdown）" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
