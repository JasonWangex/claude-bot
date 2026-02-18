import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Typography, Tag, Collapse, Space, Empty, Switch } from 'antd';
import {
  UserOutlined, RobotOutlined, ToolOutlined,
  CodeOutlined, ExclamationCircleOutlined,
  FileTextOutlined, CaretRightOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import type {
  SessionEvent, SessionSummary,
  ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock,
} from '@/lib/hooks/use-sessions';

const { Text } = Typography;

const grayExpandIcon = ({ isActive }: { isActive?: boolean }) => (
  <CaretRightOutlined rotate={isActive ? 90 : 0} style={{ fontSize: 10, color: '#bfbfbf' }} />
);

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
    const events = conversationMap.get(session.claude_session_id) || [];
    for (const event of events) {
      // Skip non-conversation events
      if (event.type !== 'user' && event.type !== 'assistant') continue;
      if (!event.message?.content) continue;

      const blocks = normalizeContent(event.message.content);
      if (blocks.length === 0) continue;

      // Skip user messages that only contain tool_result blocks (regardless of
      // userType — some sessions mark them 'external' instead of 'internal').
      // Tool results are displayed inline with their tool_use via toolResultMap.
      if (event.type === 'user') {
        const hasOnlyToolResults = blocks.every(b => b.type === 'tool_result');
        if (hasOnlyToolResults) continue;
      }

      const isInternal = event.userType === 'internal';

      messages.push({
        sessionIndex: index,
        sessionId: session.claude_session_id,
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
    const events = conversationMap.get(session.claude_session_id) || [];
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

// ========== Build display bubbles (single-pass, cross-message) ==========

interface DisplayBubble extends ConversationMessage {
  showHeader: boolean;
}

/**
 * Single-pass scan over all messages to produce display bubbles.
 * - User messages → own bubble.
 * - Assistant text blocks → text bubble (flush any accumulated tools first).
 * - Assistant non-text blocks (tool_use, thinking) → accumulate into one tool
 *   bubble, even across multiple consecutive assistant messages.
 * This guarantees sequential Read/Grep/etc. calls always merge into one bubble.
 */
function buildDisplayBubbles(messages: ConversationMessage[]): DisplayBubble[] {
  const result: DisplayBubble[] = [];

  // Tool accumulator — collects non-text blocks across assistant messages
  let toolAccum: ContentBlock[] = [];
  let toolMeta: ConversationMessage | null = null;
  let needsHeader = true; // next assistant bubble gets header

  const flushTools = () => {
    if (toolAccum.length > 0 && toolMeta) {
      result.push({
        ...toolMeta,
        blocks: [...toolAccum],
        showHeader: needsHeader,
      });
      needsHeader = false;
      toolAccum = [];
      toolMeta = null;
    }
  };

  for (const msg of messages) {
    // Session boundary — flush tools from previous session
    if (toolMeta && toolMeta.sessionId !== msg.sessionId) {
      flushTools();
      needsHeader = true;
    }

    if (msg.role === 'user') {
      flushTools();
      result.push({ ...msg, showHeader: true });
      needsHeader = true; // next assistant bubble gets header
      continue;
    }

    // Assistant message — walk blocks
    for (const block of msg.blocks) {
      const isText = block.type === 'text' && !!(block as TextBlock).text?.trim();

      if (isText) {
        flushTools();
        result.push({
          ...msg,
          blocks: [block],
          showHeader: needsHeader,
        });
        needsHeader = false;
      } else {
        // Non-text (tool_use, thinking, etc.) — accumulate
        if (!toolMeta) toolMeta = msg;
        toolAccum.push(block);
      }
    }
  }
  flushTools();

  return result;
}

// ========== Block Grouping ==========

type BlockGroup =
  | { type: 'text'; block: TextBlock }
  | { type: 'tool-group'; blocks: (ToolUseBlock | ThinkingBlock)[] }
  | { type: 'diff'; block: ToolUseBlock };

/** Group consecutive tool_use/thinking blocks into ToolCallGroups */
function groupBlocks(blocks: ContentBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let currentToolGroup: (ToolUseBlock | ThinkingBlock)[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      groups.push({ type: 'tool-group', blocks: [...currentToolGroup] });
      currentToolGroup = [];
    }
  };

  for (const block of blocks) {
    if (block.type === 'thinking') {
      currentToolGroup.push(block as ThinkingBlock);
    } else if (block.type === 'text' && (block as TextBlock).text?.trim()) {
      flushToolGroup();
      groups.push({ type: 'text', block: block as TextBlock });
    } else if (block.type === 'tool_use') {
      const tu = block as ToolUseBlock;
      // Hide Task-related tool calls — not useful for review
      if (tu.name.startsWith('Task')) continue;
      if (tu.name === 'Write' || tu.name === 'Edit') {
        flushToolGroup();
        groups.push({ type: 'diff', block: tu });
      } else {
        currentToolGroup.push(tu);
      }
    }
  }
  flushToolGroup();

  return groups;
}

// ========== DiffView ==========

const DIFF_MAX_LINES = 80;

type DiffLine = { type: 'keep' | 'add' | 'remove'; text: string };

/** LCS-based line diff */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const stack: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'keep', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', text: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: 'remove', text: oldLines[i - 1] });
      i--;
    }
  }
  return stack.reverse();
}

const diffLineStyle: Record<DiffLine['type'], React.CSSProperties> = {
  remove: { background: '#ffebe9', color: '#82071e' },
  add:    { background: '#e6ffec', color: '#116329' },
  keep:   { background: 'transparent', color: '#656d76' },
};
const diffPrefix: Record<DiffLine['type'], string> = { remove: '-', add: '+', keep: ' ' };

function DiffView({ oldText, newText }: { oldText?: string; newText: string }) {
  const lines: DiffLine[] = oldText
    ? computeLineDiff(oldText, newText)
    : newText.split('\n').map(text => ({ type: 'add' as const, text }));

  const displayed = lines.slice(0, DIFF_MAX_LINES);
  const remaining = lines.length - DIFF_MAX_LINES;

  return (
    <div style={{ borderRadius: 4, overflow: 'hidden', border: '1px solid #d0d7de' }}>
      {displayed.map((line, i) => (
        <div key={i} style={{
          ...diffLineStyle[line.type],
          padding: '1px 8px',
          fontFamily: 'monospace',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {diffPrefix[line.type]} {line.text}
        </div>
      ))}
      {remaining > 0 && (
        <div style={{ padding: '4px 8px', color: '#8c8c8c', fontSize: 12, fontStyle: 'italic' }}>
          ... {remaining} more lines
        </div>
      )}
    </div>
  );
}

// ========== Block Renderers ==========

function getToolSummary(block: ToolUseBlock): string {
  const input = block.input || {};
  if (block.name === 'Bash' && input.command) {
    return `$ ${String(input.command).slice(0, 80)}`;
  } else if (block.name === 'Read' && input.file_path) {
    return `Read ${String(input.file_path)}`;
  } else if (block.name === 'Write' && input.file_path) {
    return `Write ${String(input.file_path)}`;
  } else if (block.name === 'Edit' && input.file_path) {
    return `Edit ${String(input.file_path)}`;
  } else if ((block.name === 'Glob' || block.name === 'Grep') && input.pattern) {
    return `${block.name} ${String(input.pattern)}`;
  }
  return block.name;
}

function ToolUseBlockView({ block, result }: { block: ToolUseBlock; result?: ToolResultBlock }) {
  const [open, setOpen] = useState(false);
  const input = block.input || {};
  const summary = getToolSummary(block);

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
      expandIcon={grayExpandIcon}
      style={{ marginBottom: 4, background: 'transparent', border: 'none' }}
      items={[{
        key: '1',
        label: (
          <Space size={4}>
            <ToolOutlined style={{ fontSize: 11, color: '#bfbfbf' }} />
            <Text style={{ fontSize: 12, fontFamily: 'monospace', color: '#8c8c8c' }}>{summary}</Text>
            {result?.is_error && (
              <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                <ExclamationCircleOutlined /> error
              </Tag>
            )}
          </Space>
        ),
        children: (
          <div style={{ fontSize: 11, color: '#8c8c8c' }}>
            {/* Input */}
            <div style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 11, color: '#8c8c8c', fontWeight: 600 }}>Input:</Text>
              <pre style={{
                margin: '4px 0', padding: 8, background: 'transparent',
                borderRadius: 4, maxHeight: 200, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, color: '#8c8c8c',
              }}>
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
            {/* Result */}
            {result && (
              <div>
                <Text style={{ fontSize: 11, color: '#8c8c8c', fontWeight: 600 }}>
                  Output{result.is_error ? ' (error)' : ''}:
                </Text>
                <pre style={{
                  margin: '4px 0', padding: 8,
                  background: result.is_error ? '#fff2f0' : 'transparent',
                  borderRadius: 4, maxHeight: 300, overflow: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11,
                  color: result.is_error ? '#cf1322' : '#8c8c8c',
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

function WriteEditBlockView({ block, result }: { block: ToolUseBlock; result?: ToolResultBlock }) {
  const input = block.input || {};
  const filePath = String(input.file_path || '');
  const isWrite = block.name === 'Write';
  const content = isWrite ? String(input.content || '') : String(input.new_string || '');
  const oldContent = isWrite ? undefined : (input.old_string ? String(input.old_string) : undefined);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: 4, fontSize: 12,
      }}>
        <FileTextOutlined style={{ color: '#8c8c8c' }} />
        <Text style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 500 }}>
          {isWrite ? 'Write' : 'Edit'} {filePath}
        </Text>
        {result?.is_error && (
          <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
            <ExclamationCircleOutlined /> error
          </Tag>
        )}
      </div>
      <DiffView oldText={oldContent} newText={content} />
    </div>
  );
}

function ToolCallGroup({ blocks, toolResultMap }: { blocks: (ToolUseBlock | ThinkingBlock)[]; toolResultMap: Map<string, ToolResultBlock> }) {
  const [open, setOpen] = useState(false);

  const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
  const count = toolBlocks.length;

  // 0-1 tool calls — render items directly without group wrapper
  if (count <= 1) {
    return (
      <>
        {blocks.map((block, i) =>
          block.type === 'thinking'
            ? <ThinkingBlockView key={`think-${i}`} block={block as ThinkingBlock} />
            : <ToolUseBlockView key={(block as ToolUseBlock).id} block={block as ToolUseBlock} result={toolResultMap.get((block as ToolUseBlock).id)} />
        )}
      </>
    );
  }

  const hasErrors = toolBlocks.some(b => toolResultMap.get(b.id)?.is_error);
  const thinkingCount = blocks.length - count;

  const label = [
    `${count} tool calls`,
    thinkingCount > 0 ? `${thinkingCount} thinking` : '',
  ].filter(Boolean).join(', ');

  return (
    <Collapse
      size="small"
      activeKey={open ? ['1'] : []}
      onChange={() => setOpen(!open)}
      expandIcon={grayExpandIcon}
      style={{ marginBottom: 4, background: 'transparent', border: 'none' }}
      items={[{
        key: '1',
        label: (
          <Space size={4}>
            <ToolOutlined style={{ fontSize: 11, color: '#bfbfbf' }} />
            <Text style={{ fontSize: 12, color: '#8c8c8c' }}>
              {label}
            </Text>
            {hasErrors && (
              <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                has errors
              </Tag>
            )}
          </Space>
        ),
        children: (
          <div>
            {blocks.map((block, i) =>
              block.type === 'thinking'
                ? <ThinkingBlockView key={`think-${i}`} block={block as ThinkingBlock} />
                : <ToolUseBlockView key={(block as ToolUseBlock).id} block={block as ToolUseBlock} result={toolResultMap.get((block as ToolUseBlock).id)} />
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
      expandIcon={grayExpandIcon}
      style={{ marginBottom: 4, background: 'transparent', border: 'none' }}
      items={[{
        key: '1',
        label: (
          <Text style={{ fontSize: 12, fontStyle: 'italic', color: '#8c8c8c' }}>
            <CodeOutlined /> Thinking...
          </Text>
        ),
        children: (
          <pre style={{
            margin: 0, fontSize: 11, maxHeight: 300, overflow: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#8c8c8c',
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
  msg, singleSession, toolResultMap, showHeader,
}: {
  msg: DisplayBubble;
  singleSession?: boolean;
  toolResultMap: Map<string, ToolResultBlock>;
  showHeader: boolean;
}) {
  const isUser = msg.role === 'user';
  const color = SESSION_COLORS[msg.sessionIndex % SESSION_COLORS.length];

  const groups = useMemo(() => groupBlocks(msg.blocks), [msg.blocks]);

  if (groups.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: showHeader ? 16 : 4,
    }}>
      {/* Header: only shown for first bubble of a turn */}
      {showHeader && (
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
      )}

      {/* Message body — user: gray, assistant: blue */}
      <div style={{
        maxWidth: isUser ? '70%' : '95%',
        padding: '8px 12px',
        borderRadius: 8,
        background: isUser ? '#fafafa' : '#e6f4ff',
        border: `1px solid ${isUser ? '#f0f0f0' : '#91caff'}`,
      }}>
        {groups.map((group, i) => {
          switch (group.type) {
            case 'text':
              return (
                <div key={`text-${i}`}>
                  <MarkdownRenderer content={group.block.text} />
                </div>
              );
            case 'tool-group':
              return (
                <div key={`tools-${i}`} style={{ marginTop: i > 0 ? 8 : 0 }}>
                  <ToolCallGroup blocks={group.blocks} toolResultMap={toolResultMap} />
                </div>
              );
            case 'diff':
              return (
                <div key={`diff-${i}`} style={{ marginTop: i > 0 ? 8 : 0 }}>
                  <WriteEditBlockView block={group.block} result={toolResultMap.get(group.block.id)} />
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

// ========== Main Component ==========

/** Check if the page is scrolled near the bottom (within tolerance) */
function isNearBottom(tolerance = 150): boolean {
  const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
  return scrollHeight - scrollTop - clientHeight <= tolerance;
}

export default function ConversationViewer({ sessions, conversationMap, singleSession }: ConversationViewerProps) {
  const [textOnly, setTextOnly] = useState(false);
  const wasAtBottom = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => extractMessages(sessions, conversationMap),
    [sessions, conversationMap],
  );

  const bubbles = useMemo(
    () => buildDisplayBubbles(messages),
    [messages],
  );

  const toolResultMap = useMemo(
    () => buildToolResultMap(sessions, conversationMap),
    [sessions, conversationMap],
  );

  const visibleBubbles = useMemo(
    () => textOnly
      ? bubbles.filter(b =>
          b.role === 'user' ||
          b.blocks.some(block => block.type === 'text' && (block as TextBlock).text?.trim()),
        )
      : bubbles,
    [bubbles, textOnly],
  );

  // Track scroll position before content updates
  useEffect(() => {
    wasAtBottom.current = isNearBottom();
  });

  // Auto-scroll to bottom when content changes if user was already at bottom
  useEffect(() => {
    if (wasAtBottom.current) {
      endRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [visibleBubbles]);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  if (bubbles.length === 0) {
    return <Empty description="暂无会话内容" />;
  }

  return (
    <div style={{ padding: '8px 0', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Space size={6}>
          <Text type="secondary" style={{ fontSize: 12 }}>只看 text</Text>
          <Switch size="small" checked={textOnly} onChange={setTextOnly} />
        </Space>
      </div>
      {visibleBubbles.map((bubble, i) => (
        <MessageBubble
          key={i}
          msg={bubble}
          showHeader={bubble.showHeader}
          singleSession={singleSession}
          toolResultMap={toolResultMap}
        />
      ))}
      <div ref={endRef} />
      {/* Floating scroll-to-bottom button */}
      <div
        onClick={scrollToBottom}
        style={{
          position: 'fixed', bottom: 32, right: 32,
          width: 40, height: 40, borderRadius: '50%',
          background: '#fff', border: '1px solid #d9d9d9',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 100,
        }}
      >
        <VerticalAlignBottomOutlined style={{ fontSize: 16, color: '#8c8c8c' }} />
      </div>
    </div>
  );
}
