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
 * 将 FileChange[] 生成 GitHub 风格的 HTML diff 报告
 * 包含：文件列表导航、逐文件 unified diff、增删统计、折叠/展开
 */
export function buildChangesHtml(changes: FileChange[]): string {
  const e = escapeHtml;

  // 统计每个文件的增删
  interface FileStat { shortPath: string; type: string; add: number; del: number; }
  const stats: FileStat[] = changes.map(c => {
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
    return { shortPath, type: c.type, add, del };
  });

  const totalAdd = stats.reduce((s, f) => s + f.add, 0);
  const totalDel = stats.reduce((s, f) => s + f.del, 0);

  // 生成每个文件的 diff 表格
  const fileSections = changes.map((c, i) => {
    const st = stats[i];
    const anchor = `file-${i}`;
    const badge = c.type === 'create'
      ? '<span class="badge new">NEW</span>'
      : '<span class="badge modified">MODIFIED</span>';

    let diffRows = '';
    if (c.type === 'create' && c.content) {
      const lines = c.content.split('\n');
      diffRows = lines.map((line, j) => {
        const ln = j + 1;
        return `<tr class="add"><td class="ln empty"></td><td class="ln">${ln}</td><td class="code">+${e(line)}</td></tr>`;
      }).join('\n');
    } else if (c.patches?.length) {
      for (const p of c.patches) {
        // hunk header
        diffRows += `<tr class="hunk"><td colspan="3">@@ -${p.oldStart},${p.oldLines} +${p.newStart},${p.newLines} @@</td></tr>\n`;
        let oldLn = p.oldStart;
        let newLn = p.newStart;
        for (const line of p.lines) {
          const prefix = line[0];
          const content = line.slice(1);
          if (prefix === '+') {
            diffRows += `<tr class="add"><td class="ln empty"></td><td class="ln">${newLn}</td><td class="code">+${e(content)}</td></tr>\n`;
            newLn++;
          } else if (prefix === '-') {
            diffRows += `<tr class="del"><td class="ln">${oldLn}</td><td class="ln empty"></td><td class="code">-${e(content)}</td></tr>\n`;
            oldLn++;
          } else {
            diffRows += `<tr class="ctx"><td class="ln">${oldLn}</td><td class="ln">${newLn}</td><td class="code"> ${e(content)}</td></tr>\n`;
            oldLn++;
            newLn++;
          }
        }
      }
    }

    return `
    <div class="file" id="${anchor}">
      <div class="file-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="arrow">▼</span>
        ${badge}
        <span class="filename">${e(st.shortPath)}</span>
        <span class="file-stat">
          ${st.add > 0 ? `<span class="add-count">+${st.add}</span>` : ''}
          ${st.del > 0 ? `<span class="del-count">-${st.del}</span>` : ''}
        </span>
      </div>
      <table class="diff">${diffRows}</table>
    </div>`;
  }).join('\n');

  // 文件列表导航
  const fileList = stats.map((st, i) => {
    const icon = st.type === 'create' ? '🟢' : '🟡';
    return `<a href="#file-${i}" class="file-link">${icon} ${e(st.shortPath)} <span class="stat">+${st.add} -${st.del}</span></a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Changes: ${changes.length} files</title>
<style>
:root { --bg: #0d1117; --fg: #e6edf3; --border: #30363d; --header-bg: #161b22; --add-bg: #12261e; --add-fg: #3fb950; --del-bg: #2d1214; --del-fg: #f85149; --hunk-bg: #1a1f35; --hunk-fg: #79c0ff; --ln-fg: #484f58; --link: #58a6ff; --badge-new: #238636; --badge-mod: #9e6a03; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; }
.container { max-width: 1200px; margin: 0 auto; padding: 16px; }
.summary { padding: 16px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; background: var(--header-bg); }
.summary h1 { font-size: 20px; margin-bottom: 8px; }
.summary .stat-line { color: var(--ln-fg); }
.summary .stat-line .a { color: var(--add-fg); }
.summary .stat-line .d { color: var(--del-fg); }
.nav { padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; background: var(--header-bg); }
.nav .file-link { display: block; padding: 4px 0; color: var(--link); text-decoration: none; font-size: 13px; }
.nav .file-link:hover { text-decoration: underline; }
.nav .file-link .stat { color: var(--ln-fg); font-size: 12px; margin-left: 8px; }
.file { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
.file-header { background: var(--header-bg); padding: 10px 16px; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--border); }
.file-header .arrow { transition: transform 0.15s; font-size: 11px; }
.file.collapsed .file-header .arrow { transform: rotate(-90deg); }
.file.collapsed .diff { display: none; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase; }
.badge.new { background: var(--badge-new); color: #fff; }
.badge.modified { background: var(--badge-mod); color: #fff; }
.filename { flex: 1; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
.file-stat { white-space: nowrap; }
.add-count { color: var(--add-fg); margin-right: 6px; }
.del-count { color: var(--del-fg); }
.diff { width: 100%; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; table-layout: fixed; }
.diff td { padding: 1px 10px; vertical-align: top; }
.diff .ln { width: 50px; min-width: 50px; text-align: right; color: var(--ln-fg); user-select: none; }
.diff .ln.empty { background: transparent; }
.diff .code { white-space: pre-wrap; word-break: break-all; }
.diff tr.add { background: var(--add-bg); }
.diff tr.add .code { color: var(--add-fg); }
.diff tr.del { background: var(--del-bg); }
.diff tr.del .code { color: var(--del-fg); }
.diff tr.ctx .code { color: var(--fg); }
.diff tr.hunk td { background: var(--hunk-bg); color: var(--hunk-fg); font-style: italic; padding: 4px 10px; }
</style>
</head>
<body>
<div class="container">
  <div class="summary">
    <h1>${changes.length} file${changes.length > 1 ? 's' : ''} changed</h1>
    <div class="stat-line"><span class="a">+${totalAdd}</span> additions, <span class="d">-${totalDel}</span> deletions</div>
  </div>
  <div class="nav">${fileList}</div>
  ${fileSections}
</div>
</body>
</html>`;
}
