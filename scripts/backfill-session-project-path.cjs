/**
 * 回填 claude_sessions.project_path
 *
 * 遍历 ~/.claude/projects/ 下所有 JSONL 文件，
 * 通过文件名（session_id）匹配数据库记录，回填解码后的 project_path。
 */

const Database = require('better-sqlite3');
const { readdirSync, statSync } = require('fs');
const { join, basename } = require('path');

const DB_PATH = join(__dirname, '../data/bot.db');
const PROJECTS_DIR = join(process.env.HOME || '/tmp', '.claude', 'projects');

/**
 * 将 Claude 项目目录名解码为真实文件系统路径
 *
 * 贪心算法：从左到右逐级验证目录是否存在。
 */
function decodeProjectDirName(encoded) {
  if (!encoded.startsWith('-')) return encoded;

  const parts = encoded.slice(1).split('-');
  let resolved = '/';
  let pending = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === '') {
      if (pending) {
        try {
          if (statSync(resolved + pending).isDirectory()) {
            resolved += pending + '/';
            pending = '';
          }
        } catch {
          pending += '-';
          if (i + 1 < parts.length) {
            pending += parts[++i];
          }
          continue;
        }
      }
      if (i + 1 < parts.length) {
        pending = '.' + parts[++i];
      }
      continue;
    }

    if (!pending) {
      pending = part;
    } else {
      try {
        if (statSync(resolved + pending).isDirectory()) {
          resolved += pending + '/';
          pending = part;
          continue;
        }
      } catch {}
      pending += '-' + part;
    }
  }

  const result = resolved + pending;
  if (resolved === '/') {
    return encoded;
  }
  return result;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const updateStmt = db.prepare(`
  UPDATE claude_sessions
  SET project_path = ?
  WHERE claude_session_id = ?
`);

let updated = 0;
let scanned = 0;

const projectDirs = readdirSync(PROJECTS_DIR).filter(entry => {
  try { return statSync(join(PROJECTS_DIR, entry)).isDirectory(); }
  catch { return false; }
});

console.log(`Found ${projectDirs.length} project directories`);

// 先测试解码
console.log('\nDecode samples:');
for (const dir of projectDirs.slice(0, 8)) {
  console.log(`  ${dir} → ${decodeProjectDirName(dir)}`);
}
console.log('');

const entries = [];

for (const dirName of projectDirs) {
  const dirPath = join(PROJECTS_DIR, dirName);
  const decoded = decodeProjectDirName(dirName);

  let files;
  try {
    files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
  } catch { continue; }

  for (const file of files) {
    scanned++;
    const sessionId = basename(file, '.jsonl');
    entries.push({ decoded, sessionId });
  }
}

console.log(`Scanned ${scanned} JSONL files`);

const batchUpdate = db.transaction((items) => {
  for (const { decoded, sessionId } of items) {
    const result = updateStmt.run(decoded, sessionId);
    if (result.changes > 0) updated++;
  }
});

batchUpdate(entries);

console.log(`Updated ${updated} sessions`);

// 验证
const sample = db.prepare(`
  SELECT project_path, COUNT(*) as cnt
  FROM claude_sessions WHERE project_path IS NOT NULL
  GROUP BY project_path ORDER BY cnt DESC LIMIT 10
`).all();
console.log('\nTop project paths:');
console.table(sample);

db.close();
