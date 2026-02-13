import { Typography, Card, Spin, Space, Alert } from 'antd';
import { TaskTree } from '@/components/tasks/TaskTree';
import { useTasks } from '@/lib/hooks/use-tasks';

const { Title, Text } = Typography;

export default function Tasks() {
  const { data: tasks, isLoading, error } = useTasks();

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ margin: 0 }}>Tasks</Title>
        <Text type="secondary">Session / Task 管理</Text>
      </div>

      {error ? (
        <Alert message="加载失败" description={error.message} type="error" showIcon />
      ) : (
        <Card>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: 48 }}>
              <Spin size="large" />
            </div>
          ) : (
            <TaskTree tasks={tasks ?? []} />
          )}
        </Card>
      )}
    </Space>
  );
}
