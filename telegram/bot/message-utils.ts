/**
 * Telegram 消息发送工具
 */

import type { FileChange } from '../types/index.js';

/**
 * HTML 转义
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 将 Claude 输出的 CommonMark markdown 转换为 Telegram HTML
 *
 * 转换流程:
 * 1. 提取 fenced code blocks → 占位符（内部 HTML 转义）
 * 2. 提取 inline code → 占位符（内部 HTML 转义）
 * 3. 对剩余文本 HTML 转义
 * 4. **bold** / __bold__ → <b>bold</b>
 * 5. *italic* → <i>italic</i>（排除列表项 "* text"）
 * 6. ~~strike~~ → <s>strike</s>
 * 7. [text](url) → <a href="url">text</a>
 * 8. ## heading → <b>heading</b>
 * 9. 还原占位符
 */
export function markdownToHtml(md: string): string {
  const placeholders: string[] = [];

  const ph = (content: string): string => {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  };

  let text = md;

  // 1. Fenced code blocks: ```lang\n...\n```
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''));
    return ph(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escaped}</code></pre>`);
  });

  // 2. Inline code: `...`
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    return ph(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. HTML 转义剩余文本（逐段处理，跳过占位符）
  text = text.replace(/(\x00PH\d+\x00)|([^\x00]+)/g, (_match, placeholder, raw) => {
    if (placeholder) return placeholder;
    return escapeHtml(raw);
  });

  // 4. Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');

  // 5. Italic: *text* (但排除行首 "* " 列表项)
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');

  // 6. Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 7. Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 8. Headings: ## text → bold (行首)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 9. 还原占位符
  text = text.replace(/\x00PH(\d+)\x00/g, (_match, idx) => {
    return placeholders[parseInt(idx)];
  });

  return text;
}

/**
 * Telegram MessageEntity 类型（仅用于 buildDiffMessage 输出）
 */
export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  language?: string;
}

/**
 * 将 FileChange 构建为 Telegram 消息文本 + entities（使用 pre language="diff" 高亮）
 *
 * 消息格式：
 *   📄 path/to/file  modified  +3 -2
 *   <diff code block>
 */
export function buildDiffMessage(change: FileChange): { text: string; entities: TelegramEntity[] } {
  // 短路径
  const shortPath = change.filePath.replace(/^\/home\/[^/]+\//, '~/');
  const typeLabel = change.type === 'create' ? 'new file' : 'modified';

  // 统计增删行数
  let addCount = 0, delCount = 0;
  if (change.type === 'create' && change.content) {
    addCount = change.content.split('\n').length;
  } else if (change.patches) {
    for (const p of change.patches) {
      for (const l of p.lines) {
        if (l[0] === '+') addCount++;
        else if (l[0] === '-') delCount++;
      }
    }
  }

  // 用 emoji 颜色标注统计：🟢 +N  🔴 -M
  const statsParts: string[] = [];
  if (addCount > 0) statsParts.push(`🟢+${addCount}`);
  if (delCount > 0) statsParts.push(`🔴-${delCount}`);
  const stats = statsParts.length > 0 ? `  ${statsParts.join(' ')}` : '';

  // 只显示文件名和统计，不附带 diff 内容（完整 diff 通过 HTML 文件查看）
  const text = `📄 ${shortPath}  ${typeLabel}${stats}`;
  const entities: TelegramEntity[] = [
    { type: 'bold', offset: 0, length: text.length },
  ];

  return { text, entities };
}
