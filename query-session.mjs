import Database from 'better-sqlite3';

const db = new Database('data/bot.db', { readonly: true });

// 查询 channel 关联的 claude sessions
const sessions = db.prepare(`
  SELECT *
  FROM claude_sessions
  WHERE channel_id = '1472226715035242609'
  ORDER BY updated_at DESC
`).all();

console.log(`=== Channel 关联的 Claude Sessions (共 ${sessions.length} 个) ===\n`);

sessions.forEach((s, idx) => {
  console.log(`\n--- Session #${idx + 1} ---`);
  Object.entries(s).forEach(([key, value]) => {
    if (value === null || value === undefined) {
      console.log(`${key}: NULL`);
    } else if (key.includes('_at') && typeof value === 'number') {
      const date = new Date(value);
      console.log(`${key}: ${value} (${date.toISOString()})`);
    } else {
      console.log(`${key}: ${value}`);
    }
  });
});

// 查看 channels 表结构以了解有哪些字段
console.log('\n\n=== Channels 表字段 ===');
const channelSchema = db.prepare("PRAGMA table_info(channels)").all();
channelSchema.forEach(col => console.log(`  ${col.name} (${col.type})`));

db.close();
