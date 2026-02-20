import { useState } from 'react';
import { Typography, Card, Spin, Space, Alert, Segmented } from 'antd';
import { ChannelTree } from '@/components/channels/ChannelTree';
import { useChannels } from '@/lib/hooks/use-channels';

const { Title, Text } = Typography;

export default function Channels() {
  const [showAll, setShowAll] = useState(false);
  const { data: channels, isLoading, error } = useChannels(showAll ? 'all' : 'active');

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Channels</Title>
          <Text type="secondary">Discord Channel 管理</Text>
        </div>
        <Segmented
          options={[
            { label: '活跃', value: 'active' },
            { label: '全部', value: 'all' },
          ]}
          value={showAll ? 'all' : 'active'}
          onChange={(v) => setShowAll(v === 'all')}
        />
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
            <ChannelTree channels={channels ?? []} />
          )}
        </Card>
      )}
    </Space>
  );
}
