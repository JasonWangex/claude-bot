import { Collapse, Tag } from 'antd';
import type { InteractionLogEntry } from '@/lib/types';
import { formatDistanceToNow } from '@/lib/format';

interface InteractionTurnProps {
  entries: InteractionLogEntry[];
  turnIndex: number;
}

function formatTokens(value: number | null): string {
  if (value === null) return '';
  if (value < 1000) return value.toString();
  return (value / 1000).toFixed(1) + 'k';
}

function extractToolName(summaryText: string | null): string {
  if (!summaryText) return '工具调用';
  // 尝试提取工具名（通常是第一行或第一个词）
  const firstLine = summaryText.split('\n')[0];
  const match = firstLine.match(/^(\w+)/);
  return match ? match[1] : '工具调用';
}

export function InteractionTurn({ entries, turnIndex }: InteractionTurnProps) {
  const userEntry = entries.find(e => e.role === 'user');
  const assistantEntries = entries.filter(e => e.role === 'assistant');

  return (
    <div style={{ marginBottom: '16px' }}>
      {/* User entry */}
      {userEntry && (
        <div
          style={{
            borderLeft: '3px solid #52c41a',
            backgroundColor: '#f6ffed',
            padding: '12px 16px',
            marginBottom: '8px',
            borderRadius: '4px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontWeight: 600 }}>👤 User</span>
            <span style={{ fontSize: '12px', color: '#8c8c8c' }}>
              {formatDistanceToNow(userEntry.created_at)}
            </span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {userEntry.summary_text || '(无内容)'}
          </div>
        </div>
      )}

      {/* Assistant entries */}
      {assistantEntries.length > 0 && (
        <div
          style={{
            borderLeft: '3px solid #1677ff',
            backgroundColor: '#fff',
            padding: '12px 16px',
            borderRadius: '4px',
            border: '1px solid #f0f0f0',
          }}
        >
          {/* Header row with model and tokens */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>🤖 Assistant</span>
              {assistantEntries[0].model && (
                <Tag color="blue">{assistantEntries[0].model}</Tag>
              )}
              {(assistantEntries[0].tokens_input !== null || assistantEntries[0].tokens_output !== null) && (
                <span style={{ fontSize: '12px', color: '#8c8c8c' }}>
                  {assistantEntries[0].tokens_input !== null && `↓${formatTokens(assistantEntries[0].tokens_input)}`}
                  {assistantEntries[0].tokens_input !== null && assistantEntries[0].tokens_output !== null && ' '}
                  {assistantEntries[0].tokens_output !== null && `↑${formatTokens(assistantEntries[0].tokens_output)}`}
                </span>
              )}
              {assistantEntries[0].cost_usd !== null && (
                <span style={{ fontSize: '12px', color: '#8c8c8c' }}>
                  ${assistantEntries[0].cost_usd.toFixed(4)}
                </span>
              )}
            </div>
            <span style={{ fontSize: '12px', color: '#8c8c8c' }}>
              {formatDistanceToNow(assistantEntries[0].created_at)}
            </span>
          </div>

          {/* Content entries */}
          {assistantEntries.map((entry, idx) => {
            if (entry.content_type === 'text') {
              return (
                <div key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '8px' }}>
                  {entry.summary_text || '(无内容)'}
                </div>
              );
            } else if (entry.content_type === 'tool_use') {
              const toolName = extractToolName(entry.summary_text);
              return (
                <Collapse
                  key={idx}
                  ghost
                  size="small"
                  style={{ marginBottom: '8px' }}
                  items={[
                    {
                      key: entry.id.toString(),
                      label: `▸ ${toolName}`,
                      children: (
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px' }}>
                          {entry.summary_text || '(工具调用)'}
                        </div>
                      ),
                    },
                  ]}
                />
              );
            } else if (entry.content_type === 'tool_result') {
              return (
                <div
                  key={idx}
                  style={{
                    fontSize: '12px',
                    color: '#8c8c8c',
                    marginBottom: '8px',
                    paddingLeft: '16px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {entry.summary_text || '(结果)'}
                </div>
              );
            } else {
              // Fallback for unknown content_type
              return (
                <div key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '8px' }}>
                  {entry.summary_text || '(无内容)'}
                </div>
              );
            }
          })}
        </div>
      )}
    </div>
  );
}
