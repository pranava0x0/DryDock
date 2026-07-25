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
  -- Agent blast radius for tasks in this project: 'readonly' (plan mode,
  -- no writes), 'edits' (file edits + a narrow Bash allowlist), or 'full'
  -- (file edits + unrestricted Bash). Never maps to a permission bypass.
  autonomy     TEXT NOT NULL DEFAULT 'edits',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'claude',
  -- status lifecycle: pending -> claimed -> running -> done | failed.
  -- 'queued' sits between pending and claimed when the concurrency cap is
  -- full: pending -> queued -> claimed -> running -> ...
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
  -- Routing rule label that overrode the task's default provider/model at
  -- dispatch time. NULL when no rule matched (default routing was used).
  matched_rule  TEXT,
  -- Why a failed run failed: 'cancelled' | 'gate_failed' | 'agent_exit'.
  -- NULL for successful runs (and for failed rows written before this
  -- column existed).
  failure_reason TEXT,
  -- Provider session/thread id (claude only) so a follow-up turn can
  -- `--resume` the same conversation. NULL when the provider didn't report
  -- one (e.g. gemini, or a run that errored before the init event).
  session_id    TEXT,
  -- The run this one continues (a follow-up turn). NULL for first runs.
  -- Lets the UI render a task's runs as a thread.
  parent_run_id TEXT,
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
  -- Where the item came from. 'manual' (DryDock UI) | 'apple-notes' |
  -- 'shortcut' (Siri/Shortcuts) | 'imessage' | 'ai-generated' (the
  -- nightly idea generator) | 'github' (an issue opened directly) |
  -- 'project-file' (a project's own backlog.md). No CHECK constraint —
  -- the union is enforced in the application layer.
  source       TEXT NOT NULL DEFAULT 'manual',
  -- Stable dedup key for whatever produced this row. Namespaced by
  -- source so two feeders can't collide: Apple Notes uses a bare line
  -- key (historical, unprefixed), project files use
  -- 'projfile:<projectId>:<lineKey>', ideas use 'idea:<filename>'.
  external_id  TEXT,
  -- When the user deliberately accepted this item into the trusted
  -- backlog. NULL = it's sitting in the inbox. Existing rows are stamped
  -- with created_at by the migration: everything already in the list was
  -- implicitly triaged, so current data behaves exactly as before.
  triaged_at   INTEGER,
  -- The capture text exactly as it arrived, before parsing. Parsing is
  -- best-effort and must never be destructive — if the marker parser
  -- gets something wrong, the original is still here.
  raw_capture  TEXT,
  -- "owner/repo#42" once mirrored to the GitHub tracker (EP-13). The
  -- apple_notes_note_id pattern, per row.
  github_issue_ref TEXT,
  -- Task id created when the user burns the item down. Lets the UI link
  -- back to the actual orchestrator task that's now executing the work.
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

-- ── EP-10: the usage ledger ────────────────────────────────────────────
-- Why this table exists: the three provider readers compute rolling
-- windows on demand and throw them away, and Claude Code's own session
-- logs rotate out after ~30 days (`cleanupPeriodDays`). History was
-- actively evaporating. Every row here is derived from a local file, so
-- a re-collect can always rebuild a day — but only for days whose source
-- files still exist, which is exactly why we persist.
--
-- Grain: one row per (day × provider × surface × model × project). The
-- collectors UPSERT, so re-collecting a partial day self-heals rather
-- than double-counting.
CREATE TABLE IF NOT EXISTS usage_daily (
  day          TEXT NOT NULL,            -- 'YYYY-MM-DD', LOCAL timezone
  provider     TEXT NOT NULL,            -- 'claude' | 'codex' | 'google'
  surface      TEXT NOT NULL,            -- 'cli' | 'web' | 'import'
  -- '' when unknown. Never guessed — an empty model renders as "unknown".
  model        TEXT NOT NULL DEFAULT '',
  -- Derived from the session's own cwd, never from Claude's lossy
  -- directory encoding (see lib/providers/claude-projects.ts). '' when
  -- the session recorded no cwd.
  project_key  TEXT NOT NULL DEFAULT '',
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,  -- codex only today
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  sessions     INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  -- Antigravity activity counts land here. Google records NO token counts
  -- anywhere on disk, so its rows carry events and zero tokens — the UI
  -- must label them "activity", never imply tokens.
  events       INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (day, provider, surface, model, project_key)
);

-- Hour-of-day counts, for the "when do I actually work" rhythm heatmap.
--
-- Deliberately a separate, narrow table rather than an `hour` column on
-- usage_daily: adding hour to that primary key would multiply its rows by
-- up to 24x across every model and project dimension, to serve one card
-- that only ever asks "how many turns in this hour". Weekday is derived
-- from `day` at read time, so it can't drift out of sync with it.
CREATE TABLE IF NOT EXISTS usage_hourly (
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD', LOCAL timezone
  hour       INTEGER NOT NULL,           -- 0-23, LOCAL
  provider   TEXT NOT NULL,
  turns      INTEGER NOT NULL DEFAULT 0,
  events     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour, provider)
);

-- What each subscription costs and allows. Manually entered (the only
-- 100%-reliable source); EP-15 collectors may later write rows with a
-- non-'manual' source, and manual always wins on conflict.
CREATE TABLE IF NOT EXISTS subscriptions (
  provider        TEXT PRIMARY KEY,      -- 'claude' | 'codex' | 'google'
  plan_name       TEXT,
  price_usd_month REAL,
  renewal_day     INTEGER,               -- 1-31, or NULL if unknown
  -- Cap semantics as prose, not as truth: these change too often to
  -- hardcode. Seeded with sensible defaults, editable.
  cap_notes       TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Point-in-time "% of the window consumed" readings. Token sums can't
-- reproduce these — the providers don't publish denominators — so they
-- come from sanctioned local surfaces (the Codex app-server, Claude's
-- stats cache) or from the user typing what they saw. Always rendered
-- with their age; a stale quota reading presented as current is a
-- confident wrong value.
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  -- Quoted: WINDOW is a SQLite keyword (window functions). Kept as the
  -- column name anyway because it's the word the providers use.
  "window"    TEXT NOT NULL,             -- '5h' | 'week' | 'week_sonnet'
  used_pct    REAL,                      -- NULL when genuinely unknown
  resets_at   INTEGER,
  source      TEXT NOT NULL,             -- 'app-server'|'stats-cache'|'manual'|'browser'
  captured_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_runs_task       ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_backlog_status  ON backlog_items(status);
CREATE INDEX IF NOT EXISTS idx_backlog_project ON backlog_items(project_id);
CREATE INDEX IF NOT EXISTS idx_backlog_ext     ON backlog_items(external_id);
CREATE INDEX IF NOT EXISTS idx_usage_day       ON usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_usage_provider  ON usage_daily(provider, day);
CREATE INDEX IF NOT EXISTS idx_quota_provider  ON quota_snapshots(provider, captured_at);
