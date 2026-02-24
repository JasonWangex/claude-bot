import { useState } from 'react';
import {
  Typography, Card, Tag, Spin, Empty, Space, Row, Col, Alert,
  Button, Modal, Form, Input, Select, AutoComplete, Popconfirm, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useIdeas, createIdea, updateIdea, deleteIdea } from '@/lib/hooks/use-ideas';
import { useProjects } from '@/lib/hooks/use-projects';
import type { Idea, IdeaStatus } from '@/lib/types';

const { Title, Text } = Typography;

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
    form.setFieldsValue({ name: '', project: '', status: 'Idea' });
    setModalOpen(true);
  };

  const openEdit = (idea: Idea) => {
    setEditingIdea(idea);
    form.setFieldsValue({ name: idea.name, project: idea.project, status: idea.status });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editingIdea) {
        await updateIdea(editingIdea.id, values);
        message.success('更新成功');
      } else {
        await createIdea(values);
        message.success('创建成功');
      }
      setModalOpen(false);
      mutate();
    } catch (err: any) {
      if (err?.errorFields) return; // form validation error
      message.error(err?.message || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
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
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {statusOrder.map(status => {
            const items = grouped.get(status);
            if (!items || items.length === 0) return null;
            return (
              <div key={status}>
                <Space size={8} style={{ marginBottom: 12 }}>
                  <Tag color={statusColors[status]}>{status}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>({items.length})</Text>
                </Space>
                <Row gutter={[12, 12]}>
                  {items.map(idea => (
                    <Col key={idea.id} xs={24} md={12} lg={8}>
                      <Card
                        size="small"
                        hoverable
                        actions={[
                          <EditOutlined key="edit" onClick={() => openEdit(idea)} />,
                          <Popconfirm
                            key="delete"
                            title="确定删除？"
                            onConfirm={() => handleDelete(idea.id)}
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                          >
                            <DeleteOutlined />
                          </Popconfirm>,
                        ]}
                      >
                        <Text strong>{idea.name}</Text>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#999', marginTop: 8 }}>
                          <span>{idea.project}</span>
                          <span>{idea.date}</span>
                        </div>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </div>
            );
          })}
        </Space>
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
        </Form>
      </Modal>
    </Space>
  );
}
