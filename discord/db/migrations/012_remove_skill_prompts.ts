import type { Migration } from '../migrate.js';

/**
 * Migration 012: 删除 skill 类 prompt
 *
 * Skill prompt 已全部迁移到 ~/.claude/skills/ 直读文件，
 * session.title_generate 调用处已有硬编码 fallback，DB 条目不再需要。
 */
const migration: Migration = {
  version: 12,
  name: 'remove_skill_prompts',

  up(db) {
    db.exec(`DELETE FROM prompt_configs WHERE category = 'skill'`);
  },

  down(_db) {
    // seed 中仍保留条目定义，如需恢复可手动调用 seedPromptConfigs
  },
};

export default migration;
