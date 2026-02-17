#!/bin/bash
# Seed prompt templates to database

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB_FILE="$PROJECT_ROOT/data/bot.db"

if [ ! -f "$DB_FILE" ]; then
  echo "Error: Database file not found: $DB_FILE"
  exit 1
fi

echo "Seeding prompt templates to $DB_FILE..."

sqlite3 "$DB_FILE" < "$SCRIPT_DIR/seed-task-readiness-prompts.sql"

echo "✅ Prompt templates seeded successfully"
echo ""
echo "Loaded prompts:"
sqlite3 "$DB_FILE" "SELECT key, name FROM prompt_configs WHERE key LIKE 'orchestrator.task_readiness_check%'"
