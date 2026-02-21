import { seedPromptConfigs } from '../seeds/prompt-seeds.js';
import type { Migration } from '../migrate.js';

/**
 * 新增 orchestrator.conflict_review prompt
 *
 * 当 AI 无法自动解决 merge 冲突时，发给 reviewer 排队处理。
 * 替代原来的 "Manual resolution needed" 通知方式，改为事件驱动。
 *
 * seedPromptConfigs 使用 INSERT OR IGNORE，已有记录不会被覆盖。
 */
const migration: Migration = {
  version: 23,
  name: 'add_conflict_review_prompt',

  up(db) {
    seedPromptConfigs(db);
  },

  down(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.conflict_review');
  },
};

export default migration;
