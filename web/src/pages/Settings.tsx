import { useState } from 'react';
import { Card, Button, Typography, Space, App } from 'antd';
import { SyncOutlined, DatabaseOutlined } from '@ant-design/icons';
import { apiPost } from '@/lib/api';

const { Title, Text } = Typography;

interface SyncResult {
  discovered?: number;
  created?: number;
  updated?: number;
  sessionsScanned?: number;
  sessionsUpdated?: number;
}

export default function Settings() {
  const { message } = App.useApp();
  const [syncingSession, setSyncingSession] = useState(false);
  const [syncingUsage, setSyncingUsage] = useState(false);

  const handleSyncSessions = async () => {
    setSyncingSession(true);
    try {
      const result = await apiPost<SyncResult>('/api/sync/sessions');
      message.success(`会话同步完成：发现 ${result.discovered} 个，新增 ${result.created}，更新 ${result.updated}`);
    } catch (e: any) {
      message.error(`同步失败: ${e.message}`);
    } finally {
      setSyncingSession(false);
    }
  };

  const handleSyncUsage = async () => {
    setSyncingUsage(true);
    try {
      const result = await apiPost<SyncResult>('/api/sync/usage');
      message.success(`用量同步完成：扫描 ${result.sessionsScanned} 个会话，更新 ${result.sessionsUpdated} 个`);
    } catch (e: any) {
      message.error(`同步失败: ${e.message}`);
    } finally {
      setSyncingUsage(false);
    }
  };

  return (
    <div>
      <Title level={4}>Settings</Title>

      <Card title="数据同步" style={{ maxWidth: 600 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Button
              icon={<SyncOutlined spin={syncingSession} />}
              loading={syncingSession}
              onClick={handleSyncSessions}
            >
              同步会话记录
            </Button>
            <Text type="secondary" style={{ marginLeft: 12 }}>
              扫描 JSONL 文件，发现新会话并更新元数据
            </Text>
          </div>
          <div>
            <Button
              icon={<DatabaseOutlined />}
              loading={syncingUsage}
              onClick={handleSyncUsage}
            >
              全量同步用量数据
            </Button>
            <Text type="secondary" style={{ marginLeft: 12 }}>
              重算所有会话的 Token / Cost（历史数据补全）
            </Text>
          </div>
        </Space>
      </Card>
    </div>
  );
}
