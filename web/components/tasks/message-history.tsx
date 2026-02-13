import { cn } from '@/lib/utils';
import { formatDistanceToNow } from '@/lib/format';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface MessageHistoryProps {
  messages: Message[];
}

export function MessageHistory({ messages }: MessageHistoryProps) {
  if (messages.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        暂无消息记录
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={cn(
            'flex',
            msg.role === 'user' ? 'justify-end' : 'justify-start'
          )}
        >
          <div
            className={cn(
              'max-w-[80%] rounded-lg px-4 py-2.5',
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted'
            )}
          >
            <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
            <p
              className={cn(
                'text-[10px] mt-1',
                msg.role === 'user'
                  ? 'text-primary-foreground/70'
                  : 'text-muted-foreground'
              )}
            >
              {formatDistanceToNow(msg.timestamp)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
