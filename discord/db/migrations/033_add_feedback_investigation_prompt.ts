import { seedPromptConfigs } from '../seeds/prompt-seeds.js';
import type { Migration } from '../migrate.js';

/**
 * 新增 orchestrator.feedback_investigation prompt
 *
 * 任务上报 blocked_feedback 后，AI 调查原因并决定下一步行动。
 * 原来该 prompt 硬编码在 buildFeedbackInvestigationPrompt() 中，现迁移至数据库。
 */
const migration: Migration = {
  version: 33,
  name: 'add_feedback_investigation_prompt',

  up(db) {
    seedPromptConfigs(db);
  },

  down(db) {
    db.prepare(`DELETE FROM prompt_configs WHERE key = ?`).run('orchestrator.feedback_investigation');
  },
};

export default migration;
