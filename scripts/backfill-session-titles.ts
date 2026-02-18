/**
 * 批量补充 claude_sessions.title
 *
 * 用法: npx tsx scripts/backfill-session-titles.ts
 */

import 'dotenv/config';
import { initDb } from '../discord/db/index.js';
import { PromptConfigRepository } from '../discord/db/prompt-config-repo.js';
import { PromptConfigService } from '../discord/services/prompt-config-service.js';
import { SessionSyncService } from '../discord/sync/session-sync-service.js';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../discord/utils/logger.js';

async function main() {
  const db = initDb();

  // 初始化 PromptConfigService
  const promptRepo = new PromptConfigRepository(db);
  const promptService = new PromptConfigService(promptRepo);
  await promptService.loadAll();

  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  const syncService = new SessionSyncService(db, claudeProjectsDir);
  syncService.setPromptService(promptService);

  // 修复坏标题 — 重置为 NULL 以便重新生成
  const BAD_TITLE = '用户本地命令消息标题生成';
  const resetCount = db.prepare('UPDATE claude_sessions SET title = NULL WHERE title = ?').run(BAD_TITLE).changes;
  if (resetCount > 0) {
    logger.info(`Reset ${resetCount} sessions with bad title "${BAD_TITLE}"`);
  }

  // 统计
  const total = (db.prepare('SELECT COUNT(*) as c FROM claude_sessions').get() as any).c;
  const missing = (db.prepare('SELECT COUNT(*) as c FROM claude_sessions WHERE title IS NULL AND claude_session_id IS NOT NULL').get() as any).c;
  logger.info(`Total sessions: ${total}, missing title: ${missing}`);

  if (missing === 0) {
    logger.info('All sessions have titles, nothing to do');
    return;
  }

  await syncService.backfillTitles();

  const afterMissing = (db.prepare('SELECT COUNT(*) as c FROM claude_sessions WHERE title IS NULL AND claude_session_id IS NOT NULL').get() as any).c;
  const filled = missing - afterMissing;
  logger.info(`Done: ${filled} titles generated, ${afterMissing} still missing`);
}

main().catch(e => {
  logger.error(`Backfill failed: ${e.message}`);
  process.exit(1);
});
