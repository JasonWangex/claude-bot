import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 8,
  name: 'add_knowledge_base',

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        category    TEXT,
        tags        TEXT,
        project     TEXT NOT NULL,
        source      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_project
        ON knowledge_base(project);

      CREATE INDEX IF NOT EXISTS idx_kb_category
        ON knowledge_base(category);
    `);
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS knowledge_base;');
  },
};

export default migration;
