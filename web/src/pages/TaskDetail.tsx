import { useParams, Navigate } from 'react-router';
import { Typography, Breadcrumb, Card, Descriptions, Spin, Space, Alert, Tabs } from 'antd';
import { BranchesOutlined, FolderOutlined, ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { TaskTree } from '@/components/tasks/TaskTree';
import { useTask } from '@/lib/hooks/use-tasks';
import { formatDistanceToNow } from '@/lib/format';

const { Title } = Typography;

export default function TaskDetail() {
  const { channelId } = useParams<{ channelId: string }>();
  const { data: task, error } = useTask(channelId ?? null);

  if (!channelId) return <Navigate to="/tasks" replace />;

  if (error) {
    return <Alert message="加载失败" description={error.message} type="error" showIcon />;
  }

  if (!task) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Breadcrumb items={[
        { title: <Link to="/tasks">Tasks</Link> },
        { title: task.name },
      ]} />

      <Title level={3} style={{ margin: 0 }}>{task.name}</Title>

      <Card title="Session 信息" size="small">
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label={<><FolderOutlined /> 工作目录</>}>
            {task.cwd}
          </Descriptions.Item>
          {task.model && (
            <Descriptions.Item label={<><RobotOutlined /> 模型</>}>
              {task.model}
            </Descriptions.Item>
          )}
          {task.worktree_branch && (
            <Descriptions.Item label={<><BranchesOutlined /> 分支</>}>
              {task.worktree_branch}
            </Descriptions.Item>
          )}
          <Descriptions.Item label={<><ClockCircleOutlined /> 创建时间</>}>
            {formatDistanceToNow(task.created_at)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {task.children?.length ? (
        <Tabs
          defaultActiveKey="children"
          items={[
            {
              key: 'children',
              label: `子任务 (${task.children.length})`,
              children: <TaskTree tasks={task.children} />,
            },
          ]}
        />
      ) : null}
    </Space>
  );
}
