/**
 * Discord 消息工具
 * Discord 原生支持 Markdown，无需 HTML 转换
 */

import type { FileChange } from '../types/index.js';

/**
 * Discord Markdown 转义（转义特殊字符）
 * 只在需要防止意外格式化时使用
 */
export function escapeMarkdown(text: string): string {
  return (text ?? '').replace(/([*_~`|\\>])/g, '\\$1');
}

/**
 * 将 FileChange[] 生成 Markdown diff 摘要（用于 Embed description）
 */
export function buildChangesSummary(changes: FileChange[]): string {
  const lines: string[] = [];

  let totalAdd = 0;
  let totalDel = 0;

  for (const c of changes) {
    const shortPath = c.filePath.replace(/^\/home\/[^/]+\//, '~/');
    let add = 0, del = 0;

    if (c.type === 'create' && c.content) {
      add = c.content.split('\n').length;
    } else if (c.patches) {
      for (const p of c.patches) {
        for (const l of p.lines) {
          if (l[0] === '+') add++;
          else if (l[0] === '-') del++;
        }
      }
    }

    totalAdd += add;
    totalDel += del;

    const badge = c.type === 'create' ? '🟢' : '🟡';
    lines.push(`${badge} \`${shortPath}\` +${add} -${del}`);
  }

  lines.push(`\n**+${totalAdd}** additions, **-${totalDel}** deletions`);
  return lines.join('\n');
}

