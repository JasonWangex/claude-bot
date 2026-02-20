import { Empty, Typography } from 'antd';
import { formatDistanceToNow } from '@/lib/format';

const { Text } = Typography;

interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export function MessageHistory({ messages }: { messages: Message[] }) {
  if (messages.length === 0) {
    return <Empty description="暂无消息记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user';
        return (
          <div
            key={`${msg.timestamp}-${msg.role}-${i}`}
            style={{
              display: 'flex',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{
              maxWidth: '80%',
              padding: '10px 16px',
              borderRadius: 8,
              background: isUser ? '#1677ff' : '#f5f5f5',
              color: isUser ? '#fff' : '#262626',
            }}>
              <p style={{ margin: 0, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msg.text}
              </p>
              <Text style={{
                fontSize: 10,
                marginTop: 4,
                display: 'block',
                color: isUser ? 'rgba(255,255,255,0.7)' : '#999',
              }}>
                {formatDistanceToNow(msg.timestamp)}
              </Text>
            </div>
          </div>
        );
      })}
    </div>
  );
}
