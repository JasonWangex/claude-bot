import { Typography, Card, Row, Col, Tag, Spin, Empty, Alert, Tooltip, Button } from 'antd';
import { FolderOutlined, LinkOutlined, ApiOutlined } from '@ant-design/icons';
import { useProjects } from '@/lib/hooks/use-projects';

const { Title, Text } = Typography;

const VSCODE_SERVER = 'https://dev-server.taile0035e.ts.net';

export default function Projects() {
  const { data: projects, isLoading, error } = useProjects();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>Projects</Title>
      </div>

      {error && (
        <Alert type="error" message="加载失败" description={error.message} style={{ marginBottom: 16 }} />
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : !projects?.length ? (
        <Empty description="暂无项目（检查 PROJECTS_ROOT 配置）" />
      ) : (
        <Row gutter={[16, 16]}>
          {projects.map(p => (
            <Col key={p.name} xs={24} sm={12} md={8} lg={6}>
              <Card
                size="small"
                styles={{ body: { paddingTop: 8 } }}
                title={
                  <span>
                    <FolderOutlined style={{ marginRight: 6, color: '#faad14' }} />
                    {p.name}
                  </span>
                }
                extra={
                  <Tooltip title="在 VS Code Server 中打开">
                    <Button
                      type="link"
                      size="small"
                      icon={<LinkOutlined />}
                      href={`${VSCODE_SERVER}/?folder=${encodeURIComponent(p.full_path)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ padding: 0 }}
                    />
                  </Tooltip>
                }
              >
                <div style={{ marginBottom: 6 }}>
                  {p.category_id ? (
                    <Tag icon={<ApiOutlined />} color="blue">Discord 已绑定</Tag>
                  ) : (
                    <Tag color="default">未绑定 Discord</Tag>
                  )}
                </div>
                <Text type="secondary" style={{ fontSize: 11 }} title={p.full_path}>
                  {p.full_path}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
