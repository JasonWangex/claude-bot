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
 * HTML 转义（用于 buildChangesHtml 内部）
 */
function escapeHtml(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

/**
 * 将 FileChange[] 生成 GitHub 风格的 HTML diff 报告（用于文件附件）
 * GitHub 风格的 HTML diff 报告
 */
export function buildChangesHtml(changes: FileChange[]): string {
  const e = escapeHtml;

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
        return `<tr class="add"><td class="ln">${ln}</td><td class="code">+${e(line)}</td></tr>`;
      }).join('\n');
    } else if (c.patches?.length) {
      for (const p of c.patches) {
        diffRows += `<tr class="hunk"><td colspan="2">@@ -${p.oldStart},${p.oldLines} +${p.newStart},${p.newLines} @@</td></tr>\n`;
        let oldLn = p.oldStart;
        let newLn = p.newStart;
        for (const line of p.lines) {
          const prefix = line[0];
          const content = line.slice(1);
          if (prefix === '+') {
            diffRows += `<tr class="add"><td class="ln">${newLn}</td><td class="code">+${e(content)}</td></tr>\n`;
            newLn++;
          } else if (prefix === '-') {
            diffRows += `<tr class="del"><td class="ln">${oldLn}</td><td class="code">-${e(content)}</td></tr>\n`;
            oldLn++;
          } else {
            diffRows += `<tr class="ctx"><td class="ln">${newLn}</td><td class="code"> ${e(content)}</td></tr>\n`;
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
.diff { width: 100%; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; }
.diff td { padding: 1px 10px; vertical-align: top; }
.diff .ln { width: 1px; white-space: nowrap; text-align: right; color: var(--ln-fg); user-select: none; }
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
