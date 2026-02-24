import { Card, Typography, Space, Empty, Row, Col, Table, Button, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AimOutlined,
  UnorderedListOutlined,
  FileTextOutlined,
  BulbOutlined,
  FolderOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { StatsCard } from '@/components/StatsCard';
import { useGoals } from '@/lib/hooks/use-goals';
import { useChannels } from '@/lib/hooks/use-channels';
import { useDevLogs } from '@/lib/hooks/use-devlogs';
import { useIdeas } from '@/lib/hooks/use-ideas';
import { useProjects } from '@/lib/hooks/use-projects';
import { useUsageDaily, type DailyUsage } from '@/lib/hooks/use-usage-daily';
import { useUsageByModel, type ModelUsage } from '@/lib/hooks/use-usage-by-model';
import { formatDateTime } from '@/lib/format';

const VSCODE_SERVER = 'https://dev-server.taile0035e.ts.net';

function formatK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const { Title, Text } = Typography;

export default function Dashboard() {
  const { data: goals } = useGoals();
  const { data: channels } = useChannels();
  const { data: devlogs } = useDevLogs();
  const { data: ideas } = useIdeas();
  const { data: projects } = useProjects();
  const { data: usageDaily, isLoading: usageLoading } = useUsageDaily();
  const { data: usageByModel, isLoading: modelLoading } = useUsageByModel();

  const activeGoals = goals?.filter(g => g.status === 'Processing' || g.status === 'Collecting' || g.status === 'Planned' || g.status === 'Blocking') ?? [];
  const totalChannels = channels?.length ?? 0;
  const activeIdeas = ideas?.filter(i => i.status !== 'Done' && i.status !== 'Dropped') ?? [];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>Dashboard</Title>
      <Text type="secondary">系统概览</Text>

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <StatsCard title="Active Goals" value={activeGoals.length} icon={<AimOutlined />} description={`/ ${goals?.length ?? 0}`} />
        </Col>
        <Col xs={12} lg={6}>
          <StatsCard title="Channels" value={totalChannels} icon={<UnorderedListOutlined />} description="活跃" />
        </Col>
        <Col xs={12} lg={6}>
          <StatsCard title="DevLogs" value={devlogs?.length ?? 0} icon={<FileTextOutlined />} />
        </Col>
        <Col xs={12} lg={6}>
          <StatsCard title="Ideas" value={activeIdeas.length} icon={<BulbOutlined />} description={`/ ${ideas?.length ?? 0}`} />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="Projects" size="small">
            {!projects || projects.length === 0 ? (
              <Empty description="暂无项目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {projects.map(p => (
                  <Card size="small" key={p.name} style={{ marginBottom: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space size={6}>
                        <FolderOutlined style={{ color: '#faad14' }} />
                        <Text strong>{p.name}</Text>
                      </Space>
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
                    </div>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card title="最近 DevLogs" size="small">
            {!devlogs || devlogs.length === 0 ? (
              <Empty description="暂无开发日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {devlogs.slice(0, 5).map(log => (
                  <Card size="small" key={log.id}>
                    <Text strong>{log.name}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {log.project} · {log.commits} commits · {formatDateTime(log.created_at)}
                    </Text>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Card title="7 Day Usage" size="small">
        <Table<DailyUsage>
          dataSource={usageDaily}
          loading={usageLoading}
          rowKey="date"
          size="small"
          pagination={false}
          scroll={{ x: true }}
          summary={(data) => {
            const totals = data.reduce(
              (acc, row) => ({
                session_count: acc.session_count + row.session_count,
                tokens_in: acc.tokens_in + row.tokens_in,
                tokens_out: acc.tokens_out + row.tokens_out,
                cache_read_in: acc.cache_read_in + row.cache_read_in,
                cache_write_in: acc.cache_write_in + row.cache_write_in,
                cost_usd: acc.cost_usd + row.cost_usd,
                turn_count: acc.turn_count + row.turn_count,
              }),
              { session_count: 0, tokens_in: 0, tokens_out: 0, cache_read_in: 0, cache_write_in: 0, cost_usd: 0, turn_count: 0 },
            );
            return (
              <Table.Summary.Row style={{ fontWeight: 600 }}>
                <Table.Summary.Cell index={0}>Total</Table.Summary.Cell>
                <Table.Summary.Cell index={1}>{totals.session_count}</Table.Summary.Cell>
                <Table.Summary.Cell index={2}>{formatK(totals.tokens_in)}</Table.Summary.Cell>
                <Table.Summary.Cell index={3}>{formatK(totals.tokens_out)}</Table.Summary.Cell>
                <Table.Summary.Cell index={4}>{formatK(totals.cache_read_in)}</Table.Summary.Cell>
                <Table.Summary.Cell index={5}>{formatK(totals.cache_write_in)}</Table.Summary.Cell>
                <Table.Summary.Cell index={6}>${totals.cost_usd.toFixed(2)}</Table.Summary.Cell>
                <Table.Summary.Cell index={7}>{totals.turn_count}</Table.Summary.Cell>
              </Table.Summary.Row>
            );
          }}
          columns={[
            { title: 'Date', dataIndex: 'date', key: 'date' },
            { title: 'Sessions', dataIndex: 'session_count', key: 'session_count', align: 'right' },
            { title: 'Input', dataIndex: 'tokens_in', key: 'tokens_in', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Output', dataIndex: 'tokens_out', key: 'tokens_out', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Cache Read', dataIndex: 'cache_read_in', key: 'cache_read_in', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Cache Write', dataIndex: 'cache_write_in', key: 'cache_write_in', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Cost (USD)', dataIndex: 'cost_usd', key: 'cost_usd', align: 'right', render: (v: number) => `$${v.toFixed(2)}` },
            { title: 'Turns', dataIndex: 'turn_count', key: 'turn_count', align: 'right' },
          ] satisfies ColumnsType<DailyUsage>}
        />
      </Card>

      <Card title="7 Day Usage by Model" size="small" extra={<span style={{ fontSize: 11, color: '#999' }}>Sessions = 使用该模型的 Session 数，多模型 Session 会分别计入</span>}>
        <Table<ModelUsage>
          dataSource={usageByModel}
          loading={modelLoading}
          rowKey="model"
          size="small"
          pagination={false}
          scroll={{ x: true }}
          summary={(data) => {
            const totals = data.reduce(
              (acc, row) => ({
                session_count: acc.session_count + row.session_count,
                tokens_in: acc.tokens_in + row.tokens_in,
                tokens_out: acc.tokens_out + row.tokens_out,
                cache_read_in: acc.cache_read_in + row.cache_read_in,
                cache_write_in: acc.cache_write_in + row.cache_write_in,
                cost_usd: acc.cost_usd + row.cost_usd,
                turn_count: acc.turn_count + row.turn_count,
              }),
              { session_count: 0, tokens_in: 0, tokens_out: 0, cache_read_in: 0, cache_write_in: 0, cost_usd: 0, turn_count: 0 },
            );
            return (
              <Table.Summary.Row style={{ fontWeight: 600 }}>
                <Table.Summary.Cell index={0}>Total</Table.Summary.Cell>
                <Table.Summary.Cell index={1}>{totals.session_count}</Table.Summary.Cell>
                <Table.Summary.Cell index={2}>{formatK(totals.tokens_in)}</Table.Summary.Cell>
                <Table.Summary.Cell index={3}>{formatK(totals.tokens_out)}</Table.Summary.Cell>
                <Table.Summary.Cell index={4}>{formatK(totals.cache_read_in)}</Table.Summary.Cell>
                <Table.Summary.Cell index={5}>{formatK(totals.cache_write_in)}</Table.Summary.Cell>
                <Table.Summary.Cell index={6}>${totals.cost_usd.toFixed(2)}</Table.Summary.Cell>
                <Table.Summary.Cell index={7}>{totals.turn_count}</Table.Summary.Cell>
              </Table.Summary.Row>
            );
          }}
          columns={[
            { title: 'Model', dataIndex: 'model', key: 'model' },
            { title: 'Sessions', dataIndex: 'session_count', key: 'session_count', align: 'right' },
            { title: 'Input', dataIndex: 'tokens_in', key: 'tokens_in', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Output', dataIndex: 'tokens_out', key: 'tokens_out', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Cache Read', dataIndex: 'cache_read_in', key: 'cache_read_in', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Cache Write', dataIndex: 'cache_write_in', key: 'cache_write_in', align: 'right', render: (v: number) => formatK(v) },
            { title: 'Cost (USD)', dataIndex: 'cost_usd', key: 'cost_usd', align: 'right', render: (v: number) => `$${v.toFixed(2)}` },
            { title: 'Turns', dataIndex: 'turn_count', key: 'turn_count', align: 'right' },
          ] satisfies ColumnsType<ModelUsage>}
        />
      </Card>
    </Space>
  );
}
