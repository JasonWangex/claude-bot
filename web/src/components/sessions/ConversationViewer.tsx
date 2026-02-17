import { useState, useMemo } from 'react';
import { Typography, Tag, Collapse, Space, Empty } from 'antd';
import {
  UserOutlined, RobotOutlined, ToolOutlined,
  CodeOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import type {
  SessionEvent, SessionSummary,
  ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock,
} from '@/lib/hooks/use-sessions';

const { Text } = Typography;

// 8-color palette for multi-session display
const SESSION_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#eb2f96',
  '#722ed1', '#13c2c2', '#f5222d', '#faad14',
];

// ========== Data Model ==========

interface ConversationMessage {
  sessionIndex: number;
  sessionId: string;
  model?: string;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
  timestamp?: string;
  isInternal?: boolean; // userType === 'internal' (tool results etc.)
}

interface ConversationViewerProps {
  sessions: SessionSummary[];
  conversationMap: Map<string, SessionEvent[]>;
  singleSession?: boolean;
}

// ========== JSONL → Message Extraction ==========

/** Normalize content field: string → TextBlock[], array → as-is, other → [] */
function normalizeContent(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function extractMessages(
  sessions: SessionSummary[],
  conversationMap: Map<string, SessionEvent[]>,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  sessions.forEach((session, index) => {
    const events = conversationMap.get(session.id) || [];
    for (const event of events) {
      // Skip non-conversation events
      if (event.type !== 'user' && event.type !== 'assistant') continue;
      if (!event.message?.content) continue;

      const blocks = normalizeContent(event.message.content);
      if (blocks.length === 0) continue;

      // For user events with userType=internal, these are typically tool results
      // We still include them but mark as internal
      const isInternal = event.userType === 'internal';

      // Skip internal user messages that only contain tool_result blocks
      // (they will be shown inline with the tool_use they belong to)
      if (event.type === 'user' && isInternal) {
        const hasOnlyToolResults = blocks.every(b => b.type === 'tool_result');
        if (hasOnlyToolResults) continue;
      }

      messages.push({
        sessionIndex: index,
        sessionId: session.id,
        model: event.message.model || session.model || undefined,
        role: event.type as 'user' | 'assistant',
        blocks,
        timestamp: event.timestamp,
        isInternal,
      });
    }
  });

  // Sort by timestamp
  messages.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  return messages;
}

// ========== Tool Use / Tool Result Matching ==========

/** Build a map of tool_use_id → ToolResultBlock from all user events */
function buildToolResultMap(
  sessions: SessionSummary[],
  conversationMap: Map<string, SessionEvent[]>,
): Map<string, ToolResultBlock> {
  const map = new Map<string, ToolResultBlock>();
  for (const session of sessions) {
    const events = conversationMap.get(session.id) || [];
    for (const event of events) {
      if (event.type !== 'user') continue;
      const blocks = normalizeContent(event.message?.content);
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const tr = block as ToolResultBlock;
          map.set(tr.tool_use_id, tr);
        }
      }
    }
  }
  return map;
}

// ========== Block Renderers ==========

function ToolUseBlockView({ block, result }: { block: ToolUseBlock; result?: ToolResultBlock }) {
  const [open, setOpen] = useState(false);
  const input = block.input || {};

  // Build a concise summary line
  let summary = block.name;
  if (block.name === 'Bash' && input.command) {
    summary = `$ ${String(input.command).slice(0, 80)}`;
  } else if (block.name === 'Read' && input.file_path) {
    summary = `Read ${String(input.file_path)}`;
  } else if (block.name === 'Write' && input.file_path) {
    summary = `Write ${String(input.file_path)}`;
  } else if (block.name === 'Edit' && input.file_path) {
    summary = `Edit ${String(input.file_path)}`;
  } else if ((block.name === 'Glob' || block.name === 'Grep') && input.pattern) {
    summary = `${block.name} ${String(input.pattern)}`;
  } else if (block.name === 'Task' && input.description) {
    summary = `Task: ${String(input.description).slice(0, 60)}`;
  }

  // Format result content
  let resultText = '';
  if (result) {
    if (typeof result.content === 'string') {
      resultText = result.content;
    } else if (Array.isArray(result.content)) {
      resultText = result.content.map(c => c.text || '').join('\n');
    }
  }

  const truncatedResult = resultText.length > 3000
    ? resultText.slice(0, 3000) + '\n... (truncated)'
    : resultText;

  return (
    <Collapse
      size="small"
      activeKey={open ? ['1'] : []}
      onChange={() => setOpen(!open)}
      style={{ marginBottom: 4, background: '#fafafa' }}
      items={[{
        key: '1',
        label: (
          <Space size={4}>
            <ToolOutlined style={{ fontSize: 11, color: '#8c8c8c' }} />
            <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{summary}</Text>
            {result?.is_error && (
              <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                <ExclamationCircleOutlined /> error
              </Tag>
            )}
          </Space>
        ),
        children: (
          <div style={{ fontSize: 11 }}>
            {/* Input */}
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" strong style={{ fontSize: 11 }}>Input:</Text>
              <pre style={{
                margin: '4px 0', padding: 8, background: '#f5f5f5',
                borderRadius: 4, maxHeight: 200, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11,
              }}>
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
            {/* Result */}
            {result && (
              <div>
                <Text type="secondary" strong style={{ fontSize: 11 }}>
                  Output{result.is_error ? ' (error)' : ''}:
                </Text>
                <pre style={{
                  margin: '4px 0', padding: 8,
                  background: result.is_error ? '#fff2f0' : '#f5f5f5',
                  borderRadius: 4, maxHeight: 300, overflow: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11,
                }}>
                  {truncatedResult || '(empty)'}
                </pre>
              </div>
            )}
          </div>
        ),
      }]}
    />
  );
}

function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapse
      size="small"
      activeKey={open ? ['1'] : []}
      onChange={() => setOpen(!open)}
      style={{ marginBottom: 4, background: '#f9f0ff' }}
      items={[{
        key: '1',
        label: (
          <Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
            <CodeOutlined /> Thinking...
          </Text>
        ),
        children: (
          <pre style={{
            margin: 0, fontSize: 11, maxHeight: 300, overflow: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {block.thinking}
          </pre>
        ),
      }]}
    />
  );
}

// ========== Message Bubble ==========

function MessageBubble({
  msg, singleSession, toolResultMap,
}: {
  msg: ConversationMessage;
  singleSession?: boolean;
  toolResultMap: Map<string, ToolResultBlock>;
}) {
  const isUser = msg.role === 'user';
  const color = SESSION_COLORS[msg.sessionIndex % SESSION_COLORS.length];

  const textBlocks = msg.blocks.filter((b): b is TextBlock => b.type === 'text' && !!(b as TextBlock).text);
  const toolUseBlocks = msg.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
  const thinkingBlocks = msg.blocks.filter((b): b is ThinkingBlock => b.type === 'thinking');
  // tool_result blocks in user messages are handled via toolResultMap, skip standalone rendering

  const hasVisibleContent = textBlocks.length > 0 || toolUseBlocks.length > 0 || thinkingBlocks.length > 0;
  if (!hasVisibleContent) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 16,
    }}>
      {/* Header: role tag + session tag + timestamp */}
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
        {singleSession && !isUser && msg.model && (
          <Tag style={{ fontSize: 11 }}>{msg.model}</Tag>
        )}
        {msg.timestamp && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {new Date(msg.timestamp).toLocaleString()}
          </Text>
        )}
      </Space>

      {/* Message body */}
      <div style={{
        maxWidth: isUser ? '70%' : '95%',
        padding: '8px 12px',
        borderRadius: 8,
        background: isUser ? '#e6f4ff' : '#fafafa',
        border: `1px solid ${isUser ? '#91caff' : '#f0f0f0'}`,
      }}>
        {/* Thinking blocks (collapsed by default) */}
        {thinkingBlocks.map((block, i) => (
          <ThinkingBlockView key={`think-${i}`} block={block} />
        ))}

        {/* Text blocks */}
        {textBlocks.map((block, i) => (
          <div key={`text-${i}`}>
            <MarkdownRenderer content={block.text} />
          </div>
        ))}

        {/* Tool use blocks (with matched results) */}
        {toolUseBlocks.length > 0 && (
          <div style={{ marginTop: textBlocks.length > 0 ? 8 : 0 }}>
            {toolUseBlocks.map((block) => (
              <ToolUseBlockView
                key={block.id}
                block={block}
                result={toolResultMap.get(block.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ========== Main Component ==========

export default function ConversationViewer({ sessions, conversationMap, singleSession }: ConversationViewerProps) {
  const messages = useMemo(
    () => extractMessages(sessions, conversationMap),
    [sessions, conversationMap],
  );

  const toolResultMap = useMemo(
    () => buildToolResultMap(sessions, conversationMap),
    [sessions, conversationMap],
  );

  if (messages.length === 0) {
    return <Empty description="暂无会话内容" />;
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {messages.map((msg, i) => (
        <MessageBubble
          key={i}
          msg={msg}
          singleSession={singleSession}
          toolResultMap={toolResultMap}
        />
      ))}
    </div>
  );
}
