import { useState, useEffect } from 'react';
import {
  Typography, Card, Tag, Spin, Empty, Space, Row, Col, Alert,
  Input, Button, Modal, Form, message, Descriptions, Divider,
} from 'antd';
import {
  FileTextOutlined, SearchOutlined, EditOutlined, ReloadOutlined,
  ThunderboltOutlined, NodeIndexOutlined,
} from '@ant-design/icons';
import { apiFetch, apiPatch, apiPost } from '@/lib/api';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

interface PromptConfig {
  key: string;
  category: 'skill' | 'orchestrator';
  name: string;
  description: string | null;
  template: string;
  variables: string[];
  parent_key: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface PromptsResponse {
  data: PromptConfig[];
}

const categoryIcons: Record<string, React.ReactNode> = {
  skill: <ThunderboltOutlined />,
  orchestrator: <NodeIndexOutlined />,
};

const categoryColors: Record<string, string> = {
  skill: 'blue',
  orchestrator: 'green',
};

export default function Prompts() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'skill' | 'orchestrator' | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<PromptConfig | null>(null);
  const [previewVars, setPreviewVars] = useState<Record<string, string>>({});
  const [form] = Form.useForm();

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    try {
      setLoading(true);
      const data = await apiFetch<PromptsResponse>('/api/prompts');
      setPrompts(data.data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load prompts');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    try {
      await apiPost('/api/prompts/refresh');
      message.success('缓存已刷新');
      await loadPrompts();
    } catch (err: any) {
      message.error(err?.message || '刷新失败');
    }
  };

  const handleEdit = (prompt: PromptConfig) => {
    setEditingPrompt(prompt);
    form.setFieldsValue({
      name: prompt.name,
      description: prompt.description,
      template: prompt.template,
      variables: prompt.variables.join(', '),
    });
    // Initialize preview vars with empty strings
    const initialVars: Record<string, string> = {};
    prompt.variables.forEach(v => initialVars[v] = '');
    setPreviewVars(initialVars);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (!editingPrompt) return;

      // Parse variables from comma-separated string
      const variables = values.variables
        .split(',')
        .map((v: string) => v.trim())
        .filter((v: string) => v);

      await apiPatch(`/api/prompts/${editingPrompt.key}`, {
        name: values.name,
        description: values.description,
        template: values.template,
        variables,
      });

      message.success('更新成功');
      setEditingPrompt(null);
      form.resetFields();
      setPreviewVars({});
      await loadPrompts();
    } catch (err: any) {
      if (err?.errorFields) return; // Form validation error
      message.error(err?.message || '更新失败');
    }
  };

  const handleCancel = () => {
    setEditingPrompt(null);
    form.resetFields();
    setPreviewVars({});
  };

  const renderTemplate = (template: string, vars: Record<string, string>): string => {
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return vars[name] !== undefined && vars[name] !== '' ? vars[name] : match;
    });
  };

  const filteredPrompts = prompts.filter(prompt => {
    const matchesSearch = searchText === '' ||
      prompt.key.toLowerCase().includes(searchText.toLowerCase()) ||
      prompt.name.toLowerCase().includes(searchText.toLowerCase()) ||
      (prompt.description?.toLowerCase().includes(searchText.toLowerCase()) ?? false);
    const matchesCategory = !selectedCategory || prompt.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const groupedPrompts = new Map<string, PromptConfig[]>();
  for (const prompt of filteredPrompts) {
    if (!groupedPrompts.has(prompt.category)) {
      groupedPrompts.set(prompt.category, []);
    }
    groupedPrompts.get(prompt.category)!.push(prompt);
  }

  const sortedCategories = Array.from(groupedPrompts.keys()).sort();

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        message="加载失败"
        description={error}
        showIcon
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={2}>
          <FileTextOutlined /> Prompt 配置
        </Title>
        <Paragraph type="secondary">
          管理系统提示词模板配置，支持模板变量预览和编辑
        </Paragraph>
      </div>

      {/* Search and Filter */}
      <Row gutter={16}>
        <Col span={12}>
          <Input
            placeholder="搜索 prompt..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
          />
        </Col>
        <Col span={12}>
          <Space wrap>
            <Button
              type={selectedCategory === null ? 'primary' : 'default'}
              onClick={() => setSelectedCategory(null)}
            >
              全部
            </Button>
            <Button
              type={selectedCategory === 'skill' ? 'primary' : 'default'}
              icon={categoryIcons.skill}
              onClick={() => setSelectedCategory('skill')}
            >
              Skill
            </Button>
            <Button
              type={selectedCategory === 'orchestrator' ? 'primary' : 'default'}
              icon={categoryIcons.orchestrator}
              onClick={() => setSelectedCategory('orchestrator')}
            >
              Orchestrator
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
            >
              刷新缓存
            </Button>
          </Space>
        </Col>
      </Row>

      {/* Prompts by Category */}
      {filteredPrompts.length === 0 ? (
        <Empty description="未找到匹配的 prompt" />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {sortedCategories.map(category => (
            <Card
              key={category}
              title={
                <Space>
                  {categoryIcons[category]}
                  <span>{category}</span>
                  <Tag color={categoryColors[category]}>
                    {groupedPrompts.get(category)!.length} 条
                  </Tag>
                </Space>
              }
              size="small"
            >
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                {groupedPrompts.get(category)!.map(prompt => (
                  <Card
                    key={prompt.key}
                    type="inner"
                    size="small"
                    title={
                      <Space>
                        <Text code strong>{prompt.key}</Text>
                        <Text>{prompt.name}</Text>
                      </Space>
                    }
                    extra={
                      <Button
                        type="link"
                        icon={<EditOutlined />}
                        onClick={() => handleEdit(prompt)}
                      >
                        编辑
                      </Button>
                    }
                  >
                    <Descriptions size="small" column={1}>
                      {prompt.description && (
                        <Descriptions.Item label="描述">
                          {prompt.description}
                        </Descriptions.Item>
                      )}
                      <Descriptions.Item label="变量">
                        {prompt.variables.length > 0 ? (
                          <Space wrap>
                            {prompt.variables.map(v => (
                              <Tag key={v} color="orange">{`{{${v}}}`}</Tag>
                            ))}
                          </Space>
                        ) : (
                          <Text type="secondary">无</Text>
                        )}
                      </Descriptions.Item>
                      {prompt.parent_key && (
                        <Descriptions.Item label="父模板">
                          <Text code>{prompt.parent_key}</Text>
                        </Descriptions.Item>
                      )}
                    </Descriptions>
                  </Card>
                ))}
              </Space>
            </Card>
          ))}
        </Space>
      )}

      {/* Edit Modal */}
      <Modal
        title={`编辑 Prompt: ${editingPrompt?.key}`}
        open={!!editingPrompt}
        onOk={handleSave}
        onCancel={handleCancel}
        width={900}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <Input />
          </Form.Item>

          <Form.Item
            name="template"
            label="模板内容"
            rules={[{ required: true, message: '请输入模板内容' }]}
          >
            <TextArea rows={10} />
          </Form.Item>

          <Form.Item
            name="variables"
            label="变量列表"
            help="用逗号分隔，如: VAR1, VAR2, VAR3"
          >
            <Input placeholder="VAR1, VAR2, VAR3" />
          </Form.Item>

          {editingPrompt && editingPrompt.variables.length > 0 && (
            <>
              <Divider>模板预览</Divider>
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Text strong>填入测试变量值：</Text>
                {editingPrompt.variables.map(varName => (
                  <Form.Item key={varName} label={`{{${varName}}}`} style={{ marginBottom: 8 }}>
                    <Input
                      placeholder={`输入 ${varName} 的测试值`}
                      value={previewVars[varName] || ''}
                      onChange={(e) => setPreviewVars({ ...previewVars, [varName]: e.target.value })}
                    />
                  </Form.Item>
                ))}
                <Text strong>渲染结果：</Text>
                <TextArea
                  rows={8}
                  value={renderTemplate(form.getFieldValue('template') || '', previewVars)}
                  readOnly
                  style={{ backgroundColor: '#f5f5f5' }}
                />
              </Space>
            </>
          )}
        </Form>
      </Modal>
    </Space>
  );
}
