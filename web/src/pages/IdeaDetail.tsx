import { useState } from 'react';
import { useParams, Navigate, Link, useNavigate } from 'react-router';
import {
  Typography, Breadcrumb, Card, Tag, Space, Spin, Alert, Button, Popconfirm,
  Modal, Form, Input, Select, AutoComplete, message, Empty,
} from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useIdea, updateIdea, deleteIdea } from '@/lib/hooks/use-ideas';
import { useProjects } from '@/lib/hooks/use-projects';
import { formatDateTime } from '@/lib/format';
import { getProjectColor } from '@/lib/project-colors';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import type { IdeaStatus } from '@/lib/types';

const { Title, Text } = Typography;
const { TextArea } = Input;

const statusColors: Record<IdeaStatus, string> = {
  'Idea': 'default',
  'Processing': 'processing',
  'Active': 'success',
  'Paused': 'warning',
  'Done': 'green',
  'Dropped': 'error',
};

const statusOptions: { value: IdeaStatus; label: string }[] = [
  { value: 'Idea', label: 'Idea' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Active', label: 'Active' },
  { value: 'Paused', label: 'Paused' },
  { value: 'Done', label: 'Done' },
  { value: 'Dropped', label: 'Dropped' },
];

interface IdeaEditFormValues {
  name: string;
  project: string;
  status: IdeaStatus;
  body: string;
}

export default function IdeaDetail() {
  const { ideaId } = useParams<{ ideaId: string }>();
  const navigate = useNavigate();
  const { data: idea, error, mutate } = useIdea(ideaId ?? null);
  const { data: projectList } = useProjects();
  const [editOpen, setEditOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<IdeaEditFormValues>();

  if (!ideaId) return <Navigate to="/ideas" replace />;

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (!idea) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  const openEdit = () => {
    form.setFieldsValue({
      name: idea.name,
      project: idea.project,
      status: idea.status,
      body: idea.body ?? '',
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await updateIdea(idea.id, {
        name: values.name,
        project: values.project,
        status: values.status,
        body: values.body || null,
      });
      message.success('更新成功');
      setEditOpen(false);
      mutate();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || '更新失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteIdea(idea.id);
      message.success('删除成功');
      navigate('/ideas');
    } catch (err: any) {
      message.error(err?.message || '删除失败');
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/ideas">Ideas</Link> },
        { title: idea.name },
      ]} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={3} style={{ margin: 0 }}>{idea.name}</Title>
        <Space>
          <Button icon={<EditOutlined />} onClick={openEdit}>编辑</Button>
          <Popconfirm
            title="确定删除？"
            onConfirm={handleDelete}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      </div>

      <Space size={8} wrap>
        <Tag color={statusColors[idea.status]}>{idea.status}</Tag>
        <Tag color={getProjectColor(idea.project)}>{idea.project}</Tag>
        <Tag>{idea.date}</Tag>
        {idea.type === 'todo' && <Tag color="orange">todo</Tag>}
      </Space>

      <Text type="secondary" style={{ fontSize: 12 }}>
        创建: {formatDateTime(idea.created_at)} | 更新: {formatDateTime(idea.updated_at)}
      </Text>

      {idea.body ? (
        <Card size="small">
          <MarkdownRenderer content={idea.body} />
        </Card>
      ) : (
        <Empty description="暂无内容" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      <Modal
        title="编辑想法"
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
            <Input placeholder="想法名称" />
          </Form.Item>
          <Form.Item name="project" label="项目" rules={[{ required: true, message: '请输入项目名' }]}>
            <AutoComplete
              options={(projectList ?? []).map(p => ({ value: p.name }))}
              placeholder="所属项目"
              filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={statusOptions} />
          </Form.Item>
          <Form.Item name="body" label="内容">
            <TextArea rows={10} placeholder="Markdown 格式内容（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
