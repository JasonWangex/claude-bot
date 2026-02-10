/**
 * Telegram 消息发送工具
 */

import { Context, Telegram } from 'telegraf';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';
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
 * 发送长消息：超过 4000 字符时自动转为文件附件
 */
export async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  if (text.length > 4000) {
    const tmpFile = join(tmpdir(), `claude-${Date.now()}.md`);
    try {
      writeFileSync(tmpFile, text, 'utf-8');
      await ctx.replyWithDocument(
        { source: tmpFile, filename: 'response.md' },
        { caption: text.slice(0, 1000) + (text.length > 1000 ? '...' : ''), disable_notification: true }
      );
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
    return;
  }

  const html = markdownToHtml(text);
  try {
    await ctx.reply(html, { parse_mode: 'HTML', disable_notification: true });
  } catch {
    logger.debug('HTML parsing failed, using plain text');
    await ctx.reply(text, { parse_mode: undefined, disable_notification: true });
  }
}

/**
 * 发送长消息：不依赖 Context，直接使用 Telegram API
 * 用于 Bot 重启后重连场景
 */
export async function sendLongMessageDirect(
  telegram: Telegram,
  chatId: number,
  topicId: number,
  text: string
): Promise<void> {
  if (text.length > 4000) {
    const tmpFile = join(tmpdir(), `claude-${Date.now()}.md`);
    try {
      writeFileSync(tmpFile, text, 'utf-8');
      await telegram.sendDocument(chatId, { source: tmpFile, filename: 'response.md' }, {
        caption: text.slice(0, 1000) + (text.length > 1000 ? '...' : ''),
        message_thread_id: topicId,
        disable_notification: true,
      });
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
    return;
  }

  const html = markdownToHtml(text);
  try {
    await telegram.sendMessage(chatId, html, { parse_mode: 'HTML', message_thread_id: topicId, disable_notification: true });
  } catch {
    logger.debug('HTML parsing failed, using plain text');
    await telegram.sendMessage(chatId, text, { message_thread_id: topicId, disable_notification: true });
  }
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
  const MAX_LENGTH = 4096;

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

  // 构建统计文字
  const stats = change.type === 'create'
    ? `+${addCount}`
    : `+${addCount} -${delCount}`;

  // 头部行（含 emoji）
  const header = `📄 ${shortPath}  ${typeLabel}  ${stats}`;

  // 构建 diff body
  let diffBody = '';
  if (change.type === 'create' && change.content) {
    const lines = change.content.split('\n');
    const MAX_LINES = 50;
    const shown = lines.slice(0, MAX_LINES);
    diffBody = shown.map(l => `+${l}`).join('\n');
    if (lines.length > MAX_LINES) {
      diffBody += `\n... (${lines.length - MAX_LINES} more lines)`;
    }
  } else if (change.patches) {
    const parts: string[] = [];
    for (const patch of change.patches) {
      parts.push(`@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`);
      for (const line of patch.lines) {
        parts.push(line);
      }
    }
    diffBody = parts.join('\n');
  }

  if (!diffBody) {
    return { text: header, entities: [{ type: 'bold', offset: 0, length: header.length }] };
  }

  // 完整文本 = header + 换行 + diffBody
  let fullText = `${header}\n${diffBody}`;

  // 截断到 4096 字符以内
  if (fullText.length > MAX_LENGTH) {
    const suffix = '\n... (truncated)';
    const available = MAX_LENGTH - header.length - 1 - suffix.length; // 1 for newline
    // 截断到最近的换行
    let truncated = diffBody.slice(0, available);
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > 0) {
      truncated = truncated.slice(0, lastNewline);
    }
    diffBody = truncated + suffix;
    fullText = `${header}\n${diffBody}`;
  }

  // 构建 entities
  // JS string.length 就是 UTF-16 code unit 数，与 Telegram 要求一致
  const headerOffset = 0;
  const headerLength = header.length;
  const diffOffset = header.length + 1; // +1 for newline
  const diffLength = diffBody.length;

  const entities: TelegramEntity[] = [
    { type: 'bold', offset: headerOffset, length: headerLength },
    { type: 'pre', offset: diffOffset, length: diffLength, language: 'diff' },
  ];

  return { text: fullText, entities };
}
