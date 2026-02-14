import { useState, useEffect } from 'react';
import {
  Typography, Card, Tag, Spin, Empty, Space, Row, Col, Alert, Collapse, Descriptions,
  Input, Button,
} from 'antd';
import {
  CodeOutlined, SearchOutlined, GlobalOutlined, MessageOutlined,
  SettingOutlined, ToolOutlined, AimOutlined,
} from '@ant-design/icons';
import { apiFetch } from '@/lib/api';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

interface CommandParameter {
  name: string;
  type: 'string' | 'boolean' | 'integer';
  required: boolean;
  description: string;
}

interface CommandMeta {
  name: string;
  description: string;
  category: 'General' | 'Task' | 'Session' | 'Model' | 'Dev' | 'Goal';
  parameters?: CommandParameter[];
  examples?: string[];
  context?: 'general' | 'task_only' | 'any';
  requiresAuth?: boolean;
}

interface CommandsResponse {
  commands: CommandMeta[];
  categories: string[];
}

const categoryIcons: Record<string, React.ReactNode> = {
  General: <GlobalOutlined />,
  Task: <CodeOutlined />,
  Session: <MessageOutlined />,
  Model: <SettingOutlined />,
  Dev: <ToolOutlined />,
  Goal: <AimOutlined />,
};

const categoryColors: Record<string, string> = {
  General: 'blue',
  Task: 'green',
  Session: 'orange',
  Model: 'purple',
  Dev: 'cyan',
  Goal: 'magenta',
};

const contextLabels: Record<string, { text: string; color: string }> = {
  general: { text: 'General Channel', color: 'default' },
  task_only: { text: 'Task Channel Only', color: 'warning' },
  any: { text: 'Any Channel', color: 'success' },
};

export default function Commands() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandMeta[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    loadCommands();
  }, []);

  const loadCommands = async () => {
    try {
      setLoading(true);
      const data = await apiFetch<CommandsResponse>('/api/commands');
      setCommands(data.commands);
      setCategories(data.categories);
    } catch (err: any) {
      setError(err?.message || 'Failed to load commands');
    } finally {
      setLoading(false);
    }
  };

  const filteredCommands = commands.filter(cmd => {
    const matchesSearch = searchText === '' ||
      cmd.name.toLowerCase().includes(searchText.toLowerCase()) ||
      cmd.description.toLowerCase().includes(searchText.toLowerCase());
    const matchesCategory = !selectedCategory || cmd.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const groupedCommands = new Map<string, CommandMeta[]>();
  for (const cmd of filteredCommands) {
    if (!groupedCommands.has(cmd.category)) {
      groupedCommands.set(cmd.category, []);
    }
    groupedCommands.get(cmd.category)!.push(cmd);
  }

  // Sort categories by predefined order
  const sortedCategories = Array.from(groupedCommands.keys()).sort((a, b) => {
    const order = ['General', 'Task', 'Session', 'Model', 'Dev', 'Goal'];
    return order.indexOf(a) - order.indexOf(b);
  });

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
        <Title level={2}>Commands</Title>
        <Paragraph type="secondary">
          Discord Bot 命令列表及使用说明
        </Paragraph>
      </div>

      {/* Search and Filter */}
      <Row gutter={16}>
        <Col span={12}>
          <Input
            placeholder="搜索命令..."
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
            {categories.map(cat => (
              <Button
                key={cat}
                type={selectedCategory === cat ? 'primary' : 'default'}
                icon={categoryIcons[cat]}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </Button>
            ))}
          </Space>
        </Col>
      </Row>

      {/* Commands by Category */}
      {filteredCommands.length === 0 ? (
        <Empty description="未找到匹配的命令" />
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
                    {groupedCommands.get(category)!.length} 命令
                  </Tag>
                </Space>
              }
              size="small"
            >
              <Collapse ghost>
                {groupedCommands.get(category)!.map(cmd => (
                  <Panel
                    key={cmd.name}
                    header={
                      <Space>
                        <Text code strong>/{cmd.name}</Text>
                        <Text type="secondary">{cmd.description}</Text>
                        {cmd.context && (
                          <Tag color={contextLabels[cmd.context].color}>
                            {contextLabels[cmd.context].text}
                          </Tag>
                        )}
                        {cmd.requiresAuth && (
                          <Tag color="red">需要认证</Tag>
                        )}
                      </Space>
                    }
                  >
                    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                      {/* Parameters */}
                      {cmd.parameters && cmd.parameters.length > 0 && (
                        <div>
                          <Text strong>参数：</Text>
                          <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
                            {cmd.parameters.map(param => (
                              <Descriptions.Item
                                key={param.name}
                                label={
                                  <Space>
                                    <Text code>{param.name}</Text>
                                    <Tag color={param.required ? 'red' : 'default'}>
                                      {param.required ? '必需' : '可选'}
                                    </Tag>
                                    <Tag>{param.type}</Tag>
                                  </Space>
                                }
                              >
                                {param.description}
                              </Descriptions.Item>
                            ))}
                          </Descriptions>
                        </div>
                      )}

                      {/* Examples */}
                      {cmd.examples && cmd.examples.length > 0 && (
                        <div>
                          <Text strong>示例：</Text>
                          <ul style={{ marginTop: 8, marginBottom: 0 }}>
                            {cmd.examples.map((example, idx) => (
                              <li key={idx}>
                                <Text code>{example}</Text>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </Space>
                  </Panel>
                ))}
              </Collapse>
            </Card>
          ))}
        </Space>
      )}
    </Space>
  );
}
