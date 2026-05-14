-- DryDock schema. Source of truth — index.ts executes this file on first open.
-- All statements use IF NOT EXISTS so re-running is idempotent.

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL,
  description  TEXT,
  -- Default provider used when creating tasks under this project.
  provider     TEXT NOT NULL DEFAULT 'claude',
  -- Shell command to run inside the worktree after the agent exits 0.
  -- If null, the quality gate is skipped. Example: 'npm test'.
  test_command TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'claude',
  -- status lifecycle: pending -> claimed -> running -> done | failed
  status        TEXT NOT NULL DEFAULT 'pending',
  priority      INTEGER NOT NULL DEFAULT 0,
  branch        TEXT,
  worktree_path TEXT,
  pr_url        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  claimed_at    INTEGER,
  completed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  -- status lifecycle: running -> success | failed
  status        TEXT NOT NULL DEFAULT 'running',
  output        TEXT,
  error         TEXT,
  -- Usage capture (Phase 3). Populated from claude stream-json's `result`
  -- event. Null for runs where the provider didn't report it.
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  -- Quality-gate outcome (Phase 3). NULL = gate not run. 'passed' / 'failed'
  -- when project.test_command is set and the gate ran after agent exit 0.
  gate_status   TEXT,
  gate_output   TEXT,
  started_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at  INTEGER
);

-- Key-value settings (single-user instance, so one row per concept).
-- Examples: monthly_budget_usd, apple_notes_title, last_budget_alert_pct.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Global cross-project backlog. project_id is nullable: an item without a
-- project is a "general" idea waiting to be triaged.
CREATE TABLE IF NOT EXISTS backlog_items (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  -- Soft FK: SET NULL on project delete so backlog items survive a project
  -- being deleted (the user can re-target them later).
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  -- status lifecycle: idea -> in_progress -> done | dropped
  status       TEXT NOT NULL DEFAULT 'idea',
  priority     INTEGER NOT NULL DEFAULT 0,
  -- Where the item came from: 'manual' (created via DryDock UI) or
  -- 'apple-notes' (pulled from the synced Apple Note).
  source       TEXT NOT NULL DEFAULT 'manual',
  -- When source='apple-notes', this is the stable line key the Apple Notes
  -- sync uses to dedup. Null for manual items.
  external_id  TEXT,
  -- Task id created when the user burns the item down. Lets the UI link
  -- back to the actual orchestrator task that's now executing the work.
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_runs_task       ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_backlog_status  ON backlog_items(status);
CREATE INDEX IF NOT EXISTS idx_backlog_project ON backlog_items(project_id);
CREATE INDEX IF NOT EXISTS idx_backlog_ext     ON backlog_items(external_id);
