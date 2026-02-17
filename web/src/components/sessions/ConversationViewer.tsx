import { useState, useMemo } from 'react';
import { Typography, Tag, Collapse, Space, Empty } from 'antd';
import { UserOutlined, RobotOutlined, ToolOutlined } from '@ant-design/icons';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import type { SessionEvent, SessionSummary } from '@/lib/hooks/use-sessions';

const { Text } = Typography;

// 8-color palette for distinguishing sessions
const SESSION_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#eb2f96',
  '#722ed1', '#13c2c2', '#f5222d', '#faad14',
];

interface ConversationMessage {
  sessionIndex: number;
  sessionId: string;
  model?: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface ConversationViewerProps {
  sessions: SessionSummary[];
  /** Map of session.id → events */
  conversationMap: Map<string, SessionEvent[]>;
  /** Single session mode (no color tags) */
  singleSession?: boolean;
}

function extractMessages(
  sessions: SessionSummary[],
  conversationMap: Map<string, SessionEvent[]>,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  sessions.forEach((session, index) => {
    const events = conversationMap.get(session.id) || [];
    for (const event of events) {
      if (event.type === 'user' && event.message?.content) {
        messages.push({
          sessionIndex: index,
          sessionId: session.id,
          model: session.model || undefined,
          role: 'user',
          content: event.message.content as ContentBlock[],
          timestamp: event.timestamp,
        });
      } else if (event.type === 'assistant' && event.message?.content) {
        messages.push({
          sessionIndex: index,
          sessionId: session.id,
          model: event.message.model || session.model || undefined,
          role: 'assistant',
          content: event.message.content as ContentBlock[],
          timestamp: event.timestamp,
        });
      }
    }
  });

  // Sort by timestamp if available
  messages.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  return messages;
}

function ToolBlock({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const label = block.type === 'tool_use'
    ? `Tool: ${block.name || 'unknown'}`
    : `Tool Result`;

  const detail = block.type === 'tool_use'
    ? JSON.stringify(block.input, null, 2)
    : typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content, null, 2);

  // Truncate very long tool results
  const displayDetail = detail && detail.length > 2000
    ? detail.slice(0, 2000) + '\n... (truncated)'
    : detail;

  return (
    <Collapse
      size="small"
      activeKey={open ? ['1'] : []}
      onChange={() => setOpen(!open)}
      style={{ marginBottom: 4 }}
      items={[{
        key: '1',
        label: <Text type="secondary" style={{ fontSize: 12 }}><ToolOutlined /> {label}</Text>,
        children: <pre style={{ fontSize: 11, margin: 0, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{displayDetail || '(empty)'}</pre>,
      }]}
    />
  );
}

function MessageBubble({ msg, singleSession }: { msg: ConversationMessage; singleSession?: boolean }) {
  const isUser = msg.role === 'user';
  const color = SESSION_COLORS[msg.sessionIndex % SESSION_COLORS.length];

  const textBlocks = msg.content.filter(b => b.type === 'text' && b.text);
  const toolBlocks = msg.content.filter(b => b.type === 'tool_use' || b.type === 'tool_result');

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 16,
    }}>
      <Space size={4} style={{ marginBottom: 4 }}>
        {isUser
          ? <Tag icon={<UserOutlined />} color="default" style={{ fontSize: 11 }}>User</Tag>
          : <Tag icon={<RobotOutlined />} color="processing" style={{ fontSize: 11 }}>Assistant</Tag>
        }
        {!singleSession && (
          <Tag color={color} style={{ fontSize: 11 }}>
            {msg.model || 'unknown'} · {msg.sessionId.slice(0, 6)}
          </Tag>
        )}
        {msg.timestamp && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {new Date(msg.timestamp).toLocaleString()}
          </Text>
        )}
      </Space>

      <div style={{
        maxWidth: '85%',
        padding: '8px 12px',
        borderRadius: 8,
        background: isUser ? '#e6f4ff' : '#f5f5f5',
        border: `1px solid ${isUser ? '#91caff' : '#d9d9d9'}`,
      }}>
        {textBlocks.map((block, i) => (
          <div key={i}>
            <MarkdownRenderer content={block.text!} />
          </div>
        ))}
        {toolBlocks.length > 0 && (
          <div style={{ marginTop: textBlocks.length > 0 ? 8 : 0 }}>
            {toolBlocks.map((block, i) => (
              <ToolBlock key={i} block={block} />
            ))}
          </div>
        )}
        {textBlocks.length === 0 && toolBlocks.length === 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>(empty message)</Text>
        )}
      </div>
    </div>
  );
}

export default function ConversationViewer({ sessions, conversationMap, singleSession }: ConversationViewerProps) {
  const messages = useMemo(
    () => extractMessages(sessions, conversationMap),
    [sessions, conversationMap],
  );

  if (messages.length === 0) {
    return <Empty description="暂无会话内容" />;
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {messages.map((msg, i) => (
        <MessageBubble key={i} msg={msg} singleSession={singleSession} />
      ))}
    </div>
  );
}
