import { useState } from 'react';
import { useParams, Navigate, Link, useNavigate } from 'react-router';
import {
  Typography, Breadcrumb, Card, Tag, Space, Spin, Alert, Button, Popconfirm,
  Modal, Form, Input, Row, Col, message,
} from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useKBEntry, updateKB, deleteKB } from '@/lib/hooks/use-kb';
import { formatDateTime } from '@/lib/format';
import MarkdownRenderer from '@/components/MarkdownRenderer';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface KBEditFormValues {
  title: string;
  content: string;
  project: string;
  category?: string;
  tags?: string;
  source?: string;
}

export default function KBDetail() {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const { data: entry, error, mutate } = useKBEntry(kbId ?? null);
  const [editOpen, setEditOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<KBEditFormValues>();

  if (!kbId) return <Navigate to="/kb" replace />;

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (!entry) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  const openEdit = () => {
    form.setFieldsValue({
      title: entry.title,
      content: entry.content,
      project: entry.project,
      category: entry.category ?? '',
      tags: entry.tags.join(', '),
      source: entry.source ?? '',
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const tags = values.tags
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : [];
      await updateKB(entry.id, {
        title: values.title,
        content: values.content,
        project: values.project,
        category: values.category || undefined,
        tags,
        source: values.source || undefined,
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
      await deleteKB(entry.id);
      message.success('删除成功');
      navigate('/kb');
    } catch (err: any) {
      message.error(err?.message || '删除失败');
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/kb">Knowledge Base</Link> },
        { title: entry.title },
      ]} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={3} style={{ margin: 0 }}>{entry.title}</Title>
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

      <Space size={4} wrap>
        <Tag color="blue">{entry.project}</Tag>
        {entry.category && <Tag color="green">{entry.category}</Tag>}
        {entry.source && <Tag color="orange">来源: {entry.source}</Tag>}
        {entry.tags.map(tag => (
          <Tag key={tag}>{tag}</Tag>
        ))}
      </Space>

      <Text type="secondary" style={{ fontSize: 12 }}>
        创建: {formatDateTime(entry.created_at)} | 更新: {formatDateTime(entry.updated_at)}
      </Text>

      <Card size="small">
        <MarkdownRenderer content={entry.content} />
      </Card>

      <Modal
        title="编辑知识条目"
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
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <TextArea rows={8} placeholder="Markdown 格式内容" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="project" label="项目" rules={[{ required: true, message: '请输入项目名' }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="category" label="分类">
                <Input placeholder="如：架构、排障" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="source" label="来源">
                <Input placeholder="来源（可选）" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="tags" label="标签">
            <Input placeholder="逗号分隔，如：React, 性能, API" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
