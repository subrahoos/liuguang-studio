-- This store is created lazily by board-workflows.ts and is not a Drizzle table.
CREATE TABLE IF NOT EXISTS board_workflows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_workflows_owner_updated_idx ON board_workflows(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS board_workflow_store_migrations (
  migration_key TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
