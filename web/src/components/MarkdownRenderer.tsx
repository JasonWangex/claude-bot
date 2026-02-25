import { MarkdownHooks } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="markdown-body">
      <MarkdownHooks remarkPlugins={[remarkGfm]}>{content}</MarkdownHooks>
    </div>
  );
}
