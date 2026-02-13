import { Empty, Spin, Space, Tag } from 'antd';
import { useTaskInteractions } from '@/lib/hooks/use-tasks';
import { InteractionTurn } from './InteractionTurn';
import type { InteractionLogEntry } from '@/lib/types';

interface InteractionLogProps {
  threadId: string;
}

function formatTokens(value: number): string {
  if (value < 1000) return value.toString();
  return (value / 1000).toFixed(1) + 'k';
}

export function InteractionLog({ threadId }: InteractionLogProps) {
  const { data, error, isLoading } = useTaskInteractions(threadId);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Empty
        description={`加载失败: ${error.message || '未知错误'}`}
        style={{ padding: '48px' }}
      />
    );
  }

  if (!data) {
    return <Empty description="暂无数据" style={{ padding: '48px' }} />;
  }

  if (data.session_id === null) {
    return <Empty description="此任务没有 Claude 会话" style={{ padding: '48px' }} />;
  }

  if (data.interactions.length === 0) {
    return <Empty description="暂无交互记录" style={{ padding: '48px' }} />;
  }

  // Group by turn_index
  const turnMap = new Map<number, InteractionLogEntry[]>();
  for (const entry of data.interactions) {
    const existing = turnMap.get(entry.turn_index) ?? [];
    existing.push(entry);
    turnMap.set(entry.turn_index, existing);
  }
  const sortedTurns = [...turnMap.entries()].sort((a, b) => a[0] - b[0]);

  // Calculate statistics
  const totalInputTokens = data.interactions.reduce(
    (sum, e) => sum + (e.tokens_input || 0),
    0
  );
  const totalOutputTokens = data.interactions.reduce(
    (sum, e) => sum + (e.tokens_output || 0),
    0
  );
  const totalCost = data.interactions.reduce(
    (sum, e) => sum + (e.cost_usd || 0),
    0
  );

  return (
    <div>
      {/* Statistics summary */}
      <div style={{ marginBottom: '24px', padding: '16px', backgroundColor: '#fafafa', borderRadius: '8px' }}>
        <Space size="large">
          <span>
            <Tag color="default">共 {sortedTurns.length} 轮交互</Tag>
          </span>
          {totalInputTokens > 0 && (
            <span style={{ fontSize: '14px', color: '#595959' }}>
              输入 tokens: {formatTokens(totalInputTokens)}
            </span>
          )}
          {totalOutputTokens > 0 && (
            <span style={{ fontSize: '14px', color: '#595959' }}>
              输出 tokens: {formatTokens(totalOutputTokens)}
            </span>
          )}
          {totalCost > 0 && (
            <span style={{ fontSize: '14px', color: '#595959' }}>
              总成本: ${totalCost.toFixed(4)}
            </span>
          )}
        </Space>
      </div>

      {/* Interaction turns */}
      <div>
        {sortedTurns.map(([turnIndex, entries]) => (
          <InteractionTurn key={turnIndex} turnIndex={turnIndex} entries={entries} />
        ))}
      </div>
    </div>
  );
}
