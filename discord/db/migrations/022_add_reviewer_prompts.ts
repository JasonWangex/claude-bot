import { seedPromptConfigs } from '../seeds/prompt-seeds.js';
import type { Migration } from '../migrate.js';

/**
 * 新增 Goal Reviewer 相关 prompt 配置
 *
 * - orchestrator.reviewer_init : Drive 启动时发送给 reviewer channel 的角色初始化
 * - orchestrator.task_review   : Per-task 审核请求（原内联字符串提取为模板）
 *
 * seedPromptConfigs 使用 INSERT OR IGNORE，已有记录不会被覆盖。
 */
const migration: Migration = {
  version: 22,
  name: 'add_reviewer_prompts',

  up(db) {
    seedPromptConfigs(db);
  },

  down(db) {
    const del = db.prepare(`DELETE FROM prompt_configs WHERE key = ?`);
    del.run('orchestrator.reviewer_init');
    del.run('orchestrator.task_review');
  },
};

export default migration;
