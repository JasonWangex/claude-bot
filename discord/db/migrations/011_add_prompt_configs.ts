import type { Migration } from '../migrate.js';
import { seedPromptConfigs } from '../seeds/prompt-seeds.js';

const migration: Migration = {
  version: 11,
  name: 'add_prompt_configs',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_configs (
        key             TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        template        TEXT NOT NULL,
        variables       TEXT NOT NULL DEFAULT '[]',
        parent_key      TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_configs_category
        ON prompt_configs(category);
      CREATE INDEX IF NOT EXISTS idx_prompt_configs_parent
        ON prompt_configs(parent_key);
    `);

    // 写入种子数据
    seedPromptConfigs(db);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_prompt_configs_parent;
      DROP INDEX IF EXISTS idx_prompt_configs_category;
      DROP TABLE IF EXISTS prompt_configs;
    `);
  },
};

export default migration;
