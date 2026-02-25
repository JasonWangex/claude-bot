import { useState } from 'react';
import {
  Typography, Tag, Spin, Empty, Space, Alert,
  Button, Modal, Form, Input, Select, AutoComplete, Popconfirm, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { useIdeas, createIdea, updateIdea, deleteIdea } from '@/lib/hooks/use-ideas';
import { useProjects } from '@/lib/hooks/use-projects';
import { getProjectColor } from '@/lib/project-colors';
import type { Idea, IdeaStatus } from '@/lib/types';

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

const statusOrder: IdeaStatus[] = ['Idea', 'Processing', 'Active', 'Paused', 'Done', 'Dropped'];

interface IdeaFormValues {
  name: string;
  project: string;
  status: IdeaStatus;
  body?: string;
}

export default function Ideas() {
  const { data: ideas, isLoading, error, mutate } = useIdeas();
  const { data: projectList } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIdea, setEditingIdea] = useState<Idea | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<IdeaFormValues>();

  const openCreate = () => {
    setEditingIdea(null);
    form.setFieldsValue({ name: '', project: '', status: 'Idea', body: '' });
    setModalOpen(true);
  };

  const openEdit = (idea: Idea, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingIdea(idea);
    form.setFieldsValue({ name: idea.name, project: idea.project, status: idea.status, body: idea.body ?? '' });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editingIdea) {
        await updateIdea(editingIdea.id, { ...values, body: values.body || null });
        message.success('更新成功');
      } else {
        await createIdea({ ...values, body: values.body || undefined });
        message.success('创建成功');
      }
      setModalOpen(false);
      mutate();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      await deleteIdea(id);
      message.success('删除成功');
      mutate();
    } catch (err: any) {
      message.error(err?.message || '删除失败');
    }
  };

  // Group by status
  const grouped = new Map<IdeaStatus, Idea[]>();
  if (ideas) {
    for (const idea of ideas) {
      if (!grouped.has(idea.status)) grouped.set(idea.status, []);
      grouped.get(idea.status)!.push(idea);
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Ideas</Title>
          <Text type="secondary">想法管理</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建
        </Button>
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !ideas || ideas.length === 0 ? (
        <Empty description="暂无想法记录" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {statusOrder.map(status => {
            const items = grouped.get(status);
            if (!items || items.length === 0) return null;
            return (
              <div key={status} style={{ background: '#fff', borderRadius: 8, border: '1px solid #f0f0f0', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
                  <Tag color={statusColors[status]} style={{ margin: 0 }}>{status}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{items.length} 条</Text>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {items.map((idea, idx) => (
                    <div
                      key={idea.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: '10px 8px',
                        borderBottom: idx < items.length - 1 ? '1px solid #f5f5f5' : 'none',
                        borderRadius: 6,
                        transition: 'background 0.15s',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#fafafa')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Link
                        to={`/ideas/${idea.id}`}
                        style={{ flex: 1, minWidth: 0, color: 'inherit' }}
                      >
                        <div style={{ fontWeight: 500, color: 'rgba(0,0,0,0.88)', marginBottom: idea.body ? 4 : 0 }}>
                          {idea.name}
                        </div>
                        {idea.body && (
                          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                            {idea.body.replace(/^#+\s*/gm, '').replace(/[*`_]/g, '')}
                          </div>
                        )}
                        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <Tag color={getProjectColor(idea.project)} style={{ margin: 0, fontSize: 11 }}>{idea.project}</Tag>
                          <Text type="secondary" style={{ fontSize: 11 }}>{idea.date}</Text>
                        </div>
                      </Link>
                      <Space size={4} style={{ flexShrink: 0, paddingTop: 2 }}>
                        <EditOutlined
                          onClick={e => openEdit(idea, e)}
                          style={{ color: '#1677ff', fontSize: 13, padding: 4 }}
                        />
                        <Popconfirm
                          title="确定删除？"
                          onConfirm={e => handleDelete(idea.id, e as any)}
                          onCancel={e => { e?.preventDefault(); e?.stopPropagation(); }}
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                        >
                          <DeleteOutlined
                            onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                            style={{ color: '#ff4d4f', fontSize: 13, padding: 4 }}
                          />
                        </Popconfirm>
                      </Space>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        title={editingIdea ? '编辑想法' : '新建想法'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        okText={editingIdea ? '保存' : '创建'}
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="想法名称（简短标题）" />
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
            <TextArea rows={6} placeholder="Markdown 格式内容（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
