import { useParams, Navigate, Link } from 'react-router';
import {
  Typography, Breadcrumb, Card, Tag, Space, Spin, Alert, Descriptions,
} from 'antd';
import { BranchesOutlined, CodeOutlined } from '@ant-design/icons';
import { useDevLog } from '@/lib/hooks/use-devlogs';
import { formatDateTime } from '@/lib/format';
import MarkdownRenderer from '@/components/MarkdownRenderer';

const { Title } = Typography;

export default function DevLogDetail() {
  const { devlogId } = useParams<{ devlogId: string }>();
  const { data: log, error } = useDevLog(devlogId ?? null);

  if (!devlogId) return <Navigate to="/devlogs" replace />;

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (!log) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/devlogs">DevLogs</Link> },
        { title: log.name },
      ]} />

      <Title level={3} style={{ margin: 0 }}>{log.name}</Title>

      <Card size="small">
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
          <Descriptions.Item label="日期">{log.date}</Descriptions.Item>
          <Descriptions.Item label="项目"><Tag color="blue">{log.project}</Tag></Descriptions.Item>
          <Descriptions.Item label="分支"><BranchesOutlined /> {log.branch}</Descriptions.Item>
          <Descriptions.Item label="Commits">{log.commits}</Descriptions.Item>
          <Descriptions.Item label="代码变更"><CodeOutlined /> {log.lines_changed}</Descriptions.Item>
          {log.goal && <Descriptions.Item label="关联 Goal">{log.goal}</Descriptions.Item>}
          <Descriptions.Item label="创建时间">{formatDateTime(log.created_at)}</Descriptions.Item>
        </Descriptions>
      </Card>

      {log.summary && (
        <Card size="small" title="摘要">
          {log.summary}
        </Card>
      )}

      {log.content && (
        <Card size="small" title="内容">
          <MarkdownRenderer content={log.content} />
        </Card>
      )}
    </Space>
  );
}
