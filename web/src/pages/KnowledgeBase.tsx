import { useMemo, useState } from 'react';
import {
  Typography, Card, Tag, Spin, Empty, Space, Row, Col, Alert,
  Button, Modal, Form, Input, Select, Popconfirm, message,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router';
import { useKnowledgeBase, createKB, updateKB, deleteKB } from '@/lib/hooks/use-kb';
import { formatDateTime } from '@/lib/format';
import type { KnowledgeBaseEntry } from '@/lib/types';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

interface KBFormValues {
  title: string;
  content: string;
  project: string;
  category?: string;
  tags?: string;
  source?: string;
}

export default function KnowledgeBase() {
  const { data: entries, isLoading, error, mutate } = useKnowledgeBase();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KnowledgeBaseEntry | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<KBFormValues>();
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Derive filter options from data
  const projectOptions = useMemo(() => {
    if (!entries) return [{ value: 'all', label: '全部项目' }];
    const projects = [...new Set(entries.map(e => e.project).filter(Boolean))].sort();
    return [
      { value: 'all', label: '全部项目' },
      ...projects.map(p => ({ value: p, label: p })),
    ];
  }, [entries]);

  const categoryOptions = useMemo(() => {
    if (!entries) return [{ value: 'all', label: '全部分类' }];
    const categories = [...new Set(entries.map(e => e.category).filter(Boolean) as string[])].sort();
    return [
      { value: 'all', label: '全部分类' },
      ...categories.map(c => ({ value: c, label: c })),
    ];
  }, [entries]);

  // Filter entries
  const filtered = useMemo(() => {
    if (!entries) return [];
    let result = entries;
    if (projectFilter !== 'all') result = result.filter(e => e.project === projectFilter);
    if (categoryFilter !== 'all') result = result.filter(e => e.category === categoryFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(e =>
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    return result;
  }, [entries, projectFilter, categoryFilter, searchQuery]);

  const openCreate = () => {
    setEditingEntry(null);
    form.setFieldsValue({ title: '', content: '', project: '', category: '', tags: '', source: '' });
    setModalOpen(true);
  };

  const openEdit = (entry: KnowledgeBaseEntry) => {
    setEditingEntry(entry);
    form.setFieldsValue({
      title: entry.title,
      content: entry.content,
      project: entry.project,
      category: entry.category ?? '',
      tags: entry.tags.join(', '),
      source: entry.source ?? '',
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const tags = values.tags
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : [];

      if (editingEntry) {
        await updateKB(editingEntry.id, {
          title: values.title,
          content: values.content,
          project: values.project,
          category: values.category || undefined,
          tags,
          source: values.source || undefined,
        });
        message.success('更新成功');
      } else {
        await createKB({
          title: values.title,
          content: values.content,
          project: values.project,
          category: values.category || undefined,
          tags,
          source: values.source || undefined,
        });
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

  const handleDelete = async (id: string) => {
    try {
      await deleteKB(id);
      message.success('删除成功');
      mutate();
    } catch (err: any) {
      message.error(err?.message || '删除失败');
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Knowledge Base</Title>
          <Text type="secondary">知识库管理</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建
        </Button>
      </div>

      <Space wrap>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索标题/内容/标签"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          allowClear
          style={{ width: 220 }}
        />
        <Select
          value={projectFilter}
          onChange={setProjectFilter}
          options={projectOptions}
          style={{ width: 150 }}
        />
        <Select
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={categoryOptions}
          style={{ width: 150 }}
        />
      </Space>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description="暂无知识库条目" />
      ) : (
        <Row gutter={[16, 16]}>
          {filtered.map(entry => (
            <Col key={entry.id} xs={24} md={12} lg={8}>
              <Card
                size="small"
                hoverable
                actions={[
                  <EditOutlined key="edit" onClick={e => { e.stopPropagation(); openEdit(entry); }} />,
                  <Popconfirm
                    key="delete"
                    title="确定删除？"
                    onConfirm={e => { e?.stopPropagation(); handleDelete(entry.id); }}
                    onCancel={e => e?.stopPropagation()}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                  >
                    <DeleteOutlined onClick={e => e.stopPropagation()} />
                  </Popconfirm>,
                ]}
              >
                <Link to={`/kb/${entry.id}`} style={{ color: 'inherit' }}>
                  <Text strong>{entry.title}</Text>
                <Paragraph
                  type="secondary"
                  style={{ fontSize: 13, marginTop: 4, marginBottom: 4 }}
                  ellipsis={{ rows: 2 }}
                >
                  {entry.content}
                </Paragraph>
                <Space size={4} wrap>
                  <Tag color="blue">{entry.project}</Tag>
                  {entry.category && <Tag>{entry.category}</Tag>}
                  {entry.tags.map(tag => (
                    <Tag key={tag} style={{ fontSize: 11 }}>{tag}</Tag>
                  ))}
                </Space>
                <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>
                  {formatDateTime(entry.updated_at)}
                </div>
                </Link>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* Create / Edit Modal */}
      <Modal
        title={editingEntry ? '编辑知识条目' : '新建知识条目'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        okText={editingEntry ? '保存' : '创建'}
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="知识条目标题" />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <TextArea rows={8} placeholder="Markdown 格式内容" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="project" label="项目" rules={[{ required: true, message: '请输入项目名' }]}>
                <Input placeholder="所属项目" />
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
