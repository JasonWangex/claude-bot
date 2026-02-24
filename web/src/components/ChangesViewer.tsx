import { useState } from 'react';
import type { FileChange } from '@/lib/types';

interface ChangesViewerProps {
  fileChanges: FileChange[];
}

interface FileStat {
  shortPath: string;
  add: number;
  del: number;
}

function computeStats(changes: FileChange[]): FileStat[] {
  return changes.map((c) => {
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
    return { shortPath, add, del };
  });
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  lineNo: number | null;
  content: string;
}

function buildDiffLines(c: FileChange): DiffLine[] {
  const lines: DiffLine[] = [];
  if (c.type === 'create' && c.content) {
    c.content.split('\n').forEach((line, i) => {
      lines.push({ type: 'add', lineNo: i + 1, content: line });
    });
  } else if (c.patches?.length) {
    for (const p of c.patches) {
      lines.push({
        type: 'hunk',
        lineNo: null,
        content: `@@ -${p.oldStart},${p.oldLines} +${p.newStart},${p.newLines} @@`,
      });
      let oldLn = p.oldStart;
      let newLn = p.newStart;
      for (const line of p.lines) {
        const prefix = line[0];
        const content = line.slice(1);
        if (prefix === '+') {
          lines.push({ type: 'add', lineNo: newLn++, content });
        } else if (prefix === '-') {
          lines.push({ type: 'del', lineNo: oldLn++, content });
        } else {
          lines.push({ type: 'ctx', lineNo: newLn, content });
          oldLn++;
          newLn++;
        }
      }
    }
  }
  return lines;
}

function FileSection({ change, stat, index }: { change: FileChange; stat: FileStat; index: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const diffLines = buildDiffLines(change);
  const isNew = change.type === 'create';

  return (
    <div style={{
      border: '1px solid #30363d',
      borderRadius: 6,
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      <div
        id={`file-${index}`}
        onClick={() => setCollapsed(!collapsed)}
        style={{
          background: '#161b22',
          padding: '10px 16px',
          cursor: 'pointer',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          fontWeight: 600,
          borderBottom: collapsed ? 'none' : '1px solid #30363d',
        }}
      >
        <span style={{ fontSize: 11, transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : undefined }}>▼</span>
        <span style={{
          fontSize: 11,
          padding: '1px 6px',
          borderRadius: 3,
          fontWeight: 600,
          textTransform: 'uppercase',
          background: isNew ? '#238636' : '#9e6a03',
          color: '#fff',
        }}>
          {isNew ? 'NEW' : 'MODIFIED'}
        </span>
        <span style={{
          flex: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          color: '#e6edf3',
        }}>
          {stat.shortPath}
        </span>
        <span style={{ whiteSpace: 'nowrap' }}>
          {stat.add > 0 && <span style={{ color: '#3fb950', marginRight: 6 }}>+{stat.add}</span>}
          {stat.del > 0 && <span style={{ color: '#f85149' }}>-{stat.del}</span>}
        </span>
      </div>

      {!collapsed && (
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          fontSize: 12,
        }}>
          <tbody>
            {diffLines.map((line, i) => {
              if (line.type === 'hunk') {
                return (
                  <tr key={i}>
                    <td colSpan={2} style={{
                      background: '#1a1f35',
                      color: '#79c0ff',
                      fontStyle: 'italic',
                      padding: '4px 10px',
                    }}>
                      {line.content}
                    </td>
                  </tr>
                );
              }
              const rowBg = line.type === 'add' ? '#12261e' : line.type === 'del' ? '#2d1214' : 'transparent';
              const codeFg = line.type === 'add' ? '#3fb950' : line.type === 'del' ? '#f85149' : '#e6edf3';
              const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
              return (
                <tr key={i} style={{ background: rowBg }}>
                  <td style={{
                    width: 1,
                    whiteSpace: 'nowrap',
                    textAlign: 'right',
                    color: '#484f58',
                    userSelect: 'none',
                    padding: '1px 10px',
                    verticalAlign: 'top',
                  }}>
                    {line.lineNo}
                  </td>
                  <td style={{
                    color: codeFg,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    padding: '1px 10px',
                    verticalAlign: 'top',
                  }}>
                    {prefix}{line.content}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ChangesViewer({ fileChanges }: ChangesViewerProps) {
  const stats = computeStats(fileChanges);
  const totalAdd = stats.reduce((s, f) => s + f.add, 0);
  const totalDel = stats.reduce((s, f) => s + f.del, 0);

  return (
    <div style={{ background: '#0d1117', color: '#e6edf3', padding: 16, borderRadius: 8 }}>
      {/* 摘要 */}
      <div style={{
        padding: 16,
        border: '1px solid #30363d',
        borderRadius: 6,
        marginBottom: 16,
        background: '#161b22',
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
          {fileChanges.length} file{fileChanges.length !== 1 ? 's' : ''} changed
        </div>
        <div style={{ color: '#484f58', fontSize: 13 }}>
          <span style={{ color: '#3fb950' }}>+{totalAdd}</span>
          {' additions, '}
          <span style={{ color: '#f85149' }}>-{totalDel}</span>
          {' deletions'}
        </div>
      </div>

      {/* 文件导航 */}
      {fileChanges.length > 1 && (
        <div style={{
          padding: '12px 16px',
          border: '1px solid #30363d',
          borderRadius: 6,
          marginBottom: 16,
          background: '#161b22',
        }}>
          {stats.map((st, i) => {
            const icon = fileChanges[i].type === 'create' ? '🟢' : '🟡';
            return (
              <a
                key={i}
                href={`#file-${i}`}
                style={{
                  display: 'block',
                  padding: '4px 0',
                  color: '#58a6ff',
                  textDecoration: 'none',
                  fontSize: 13,
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                }}
              >
                {icon} {st.shortPath}{' '}
                <span style={{ color: '#484f58', fontSize: 12 }}>+{st.add} -{st.del}</span>
              </a>
            );
          })}
        </div>
      )}

      {/* 各文件 diff */}
      {fileChanges.map((c, i) => (
        <FileSection key={i} change={c} stat={stats[i]} index={i} />
      ))}
    </div>
  );
}
