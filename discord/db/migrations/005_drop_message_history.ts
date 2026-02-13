import type { Migration } from '../migrate.js';

const migration: Migration = {
  version: 5,
  name: 'drop_message_history',

  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS message_history;
    `);
  },

  down(db) {
    // Recreate message_history table if needed to rollback
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text        TEXT NOT NULL,
        timestamp   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_message_history_session
        ON message_history(session_id, timestamp);
    `);
  },
};

export default migration;
