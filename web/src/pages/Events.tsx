import { useState } from 'react';
import {
  Typography, Table, Tag, Spin, Empty, Alert, Space, Select, Switch,
  Tooltip, Collapse,
} from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { useEvents } from '@/lib/hooks/use-events';
import { formatDateTime } from '@/lib/format';
import type { TaskEvent } from '@/lib/types';

const { Title, Text } = Typography;

const EVENT_TYPE_COLORS: Record<string, string> = {
  'task.completed': 'green',
  'task.feedback': 'orange',
  'review.task_result': 'blue',
  'review.phase_result': 'purple',
  'merge.conflict': 'red',
  'review.conflict_result': 'cyan',
};

const EVENT_TYPES = [
  'task.completed',
  'task.feedback',
  'review.task_result',
  'review.phase_result',
  'merge.conflict',
  'review.conflict_result',
];

const DEFAULT_SIZE = 50;

export default function Events() {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [onlyPending, setOnlyPending] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_SIZE);

  const { data, isLoading, error } = useEvents({
    type: typeFilter !== 'all' ? typeFilter : undefined,
    pending: onlyPending || undefined,
    page,
    size,
  });

  const handleFilterChange = (setter: (v: any) => void) => (v: any) => {
    setter(v);
    setPage(1);
  };

  const columns = [
    {
      title: '类型',
      dataIndex: 'eventType',
      key: 'eventType',
      width: 200,
      render: (type: string) => (
        <Tag color={EVENT_TYPE_COLORS[type] ?? 'default'}>{type}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'processedAt',
      key: 'status',
      width: 100,
      render: (processedAt: number | null) =>
        processedAt ? (
          <Tooltip title={`已处理: ${formatDateTime(processedAt)}`}>
            <CheckCircleOutlined style={{ color: '#52c41a' }} />
            <Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>已处理</Text>
          </Tooltip>
        ) : (
          <Tooltip title="待处理">
            <ClockCircleOutlined style={{ color: '#faad14' }} />
            <Text style={{ marginLeft: 4, fontSize: 12, color: '#faad14' }}>待处理</Text>
          </Tooltip>
        ),
    },
    {
      title: 'Task ID',
      dataIndex: 'taskId',
      key: 'taskId',
      width: 200,
      render: (taskId: string) => (
        <Text code style={{ fontSize: 12 }}>{taskId.slice(0, 12)}…</Text>
      ),
    },
    {
      title: 'Goal',
      dataIndex: 'goalId',
      key: 'goalId',
      width: 160,
      render: (goalId: string | null) =>
        goalId ? (
          <Link to={`/goals/${goalId}`}>
            <Text code style={{ fontSize: 12 }}>{goalId.slice(0, 12)}…</Text>
          </Link>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 80,
      render: (source: string) => <Tag>{source}</Tag>,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: number) => (
        <Text type="secondary" style={{ fontSize: 12 }}>{formatDateTime(ts)}</Text>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Events</Title>
          <Text type="secondary">Task 事件总览</Text>
        </div>
        <Space>
          <Select
            value={typeFilter}
            onChange={handleFilterChange(setTypeFilter)}
            style={{ width: 200 }}
            options={[
              { value: 'all', label: '全部类型' },
              ...EVENT_TYPES.map(t => ({ value: t, label: t })),
            ]}
          />
          <Space size={4}>
            <Switch size="small" checked={onlyPending} onChange={handleFilterChange(setOnlyPending)} />
            <Text style={{ fontSize: 13 }}>仅待处理</Text>
          </Space>
        </Space>
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : isLoading && !data ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : data?.total === 0 ? (
        <Empty description="暂无事件" />
      ) : (
        <Table<TaskEvent>
          dataSource={data?.items ?? []}
          columns={columns}
          rowKey="id"
          size="small"
          loading={isLoading}
          pagination={{
            current: page,
            pageSize: size,
            total: data?.total ?? 0,
            defaultPageSize: DEFAULT_SIZE,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, s) => {
              setPage(p);
              setSize(s);
            },
          }}
          expandable={{
            expandedRowRender: (record) => (
              <Collapse
                size="small"
                items={[{
                  key: '1',
                  label: 'Payload',
                  children: (
                    <pre style={{ margin: 0, fontSize: 12, overflowX: 'auto' }}>
                      {JSON.stringify(record.payload, null, 2)}
                    </pre>
                  ),
                }]}
                defaultActiveKey={['1']}
              />
            ),
          }}
        />
      )}
    </Space>
  );
}
