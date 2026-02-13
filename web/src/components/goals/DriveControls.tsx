import { useState } from 'react';
import { Button, Space, Typography } from 'antd';
import { PauseOutlined, CaretRightOutlined, WarningOutlined } from '@ant-design/icons';
import { DriveStatusBadge } from './StatusBadge';
import { pauseDrive, resumeDrive } from '@/lib/hooks/use-goals';
import type { GoalDriveStatus } from '@/lib/types';

const { Text } = Typography;

interface DriveControlsProps {
  goalId: string;
  status: GoalDriveStatus;
  onAction?: () => void;
}

export function DriveControls({ goalId, status, onAction }: DriveControlsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePause = async () => {
    setLoading(true);
    setError(null);
    try {
      await pauseDrive(goalId);
      onAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '暂停失败');
    } finally {
      setLoading(false);
    }
  };

  const handleResume = async () => {
    setLoading(true);
    setError(null);
    try {
      await resumeDrive(goalId);
      onAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space>
      <DriveStatusBadge status={status} />
      {error && <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>}
      {status === 'running' && (
        <Button size="small" icon={<PauseOutlined />} onClick={handlePause} loading={loading}>
          暂停
        </Button>
      )}
      {status === 'paused' && (
        <Button size="small" icon={<CaretRightOutlined />} onClick={handleResume} loading={loading}>
          恢复
        </Button>
      )}
      {status === 'failed' && (
        <Text type="danger" style={{ fontSize: 14 }}>
          <WarningOutlined /> Drive 失败
        </Text>
      )}
    </Space>
  );
}
