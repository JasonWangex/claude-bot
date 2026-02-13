import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 5,
  name: 'add_interaction_log',

  up(db) {
    db.exec(`
      CREATE TABLE interaction_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        turn_index      INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content_type    TEXT,
        summary_text    TEXT,
        model           TEXT,
        tokens_input    INTEGER,
        tokens_output   INTEGER,
        cost_usd        REAL,
        jsonl_path      TEXT,
        created_at      INTEGER NOT NULL,
        UNIQUE(session_id, turn_index, role)
      );

      CREATE INDEX idx_interaction_log_session
        ON interaction_log(session_id, turn_index);
      CREATE INDEX idx_interaction_log_created_at
        ON interaction_log(created_at);
    `);
  },

  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS interaction_log;
    `);
  },
};

export default migration;
