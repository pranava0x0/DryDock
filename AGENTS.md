# DryDock — Notes for AI Agents

This file is read by AI agents (Claude Code, Gemini CLI) when they start working inside the DryDock repository. Keep it tight — every line here costs context.

## What DryDock is

A personal project orchestrator. It dispatches coding tasks to Claude Code / Gemini CLI subprocesses and shows the live stdout in a mobile-first PWA. There is no API key — providers authenticate via OAuth sessions on the host Mac (`~/.claude/`, `~/.gemini/`).

## Tech invariants

- Next.js 15 App Router, TypeScript strict, Tailwind 3, React 19 RC.
- API routes run on the **Node runtime** (`export const runtime = "nodejs"`). Never switch to Edge — the DB layer uses better-sqlite3 (native bindings) and the dispatcher spawns child processes.
- SQLite via `better-sqlite3`, single connection per process, WAL mode. DB file lives at `~/.drydock/drydock.db` (outside the repo). Schema is sourced from [lib/db/schema.sql](lib/db/schema.sql) and executed on first connection.
- All state mutations go through [lib/db/*.ts](lib/db). Don't write raw SQL in route handlers.
- The atomic task claim (`UPDATE tasks SET status='claimed' WHERE id=? AND status='pending'`, checking `changes === 1`) is the safety net against duplicate dispatch. Don't bypass it.
- Subprocess timeout: 10 minutes (`DEFAULT_AGENT_TIMEOUT_MS` in [lib/providers/spawn.ts](lib/providers/spawn.ts)). SIGTERM, then SIGKILL after 2s grace.
- SSE event flow: dispatcher publishes to [lib/orchestrator/hub.ts](lib/orchestrator/hub.ts) → the `/api/tasks/[id]/stream` route subscribes via `subscribe(runId)`. If the run is already terminal, the route replays from the `runs` row via [lib/orchestrator/replay.ts](lib/orchestrator/replay.ts) instead (see [DD-001/DD-002](issues.md)).
- **Only one** `exit` event is ever published per run, synthesized by the dispatcher *after* the gate + worktree-cleanup steps complete. The agent's own exit event is intentionally suppressed so live SSE viewers see the whole story (gate transcript, cleanup notes) instead of being cut off at the agent's terminator. See [DD-003](issues.md).
- Schema migrations run automatically on every DB open via `migrate()` in [lib/db/index.ts](lib/db/index.ts). New columns must be added through `ensure(table, col, ddl)` calls there, NOT only in `schema.sql` — existing Phase 1/2 DBs won't pick up `CREATE TABLE IF NOT EXISTS` changes.
- Claude provider runs `--output-format stream-json --verbose`. Each stdout line is one JSON event. [claude-parse.ts](lib/providers/claude-parse.ts) flattens `assistant` events into text and turns the final `result` event into a structured `usage` AgentEvent variant — that's how `runs.tokens_in/out` and `runs.cost_usd` get populated.
- **Apple Notes is identified by a stable note id, not by name.** [lib/integrations/apple-notes.ts](lib/integrations/apple-notes.ts) `buildWriteScript` / `buildReadScript` accept a `knownId` (Apple's `x-coredata://…/ICNote/p<n>` URL) and hit the note via `note id "…"` directly. The id is persisted in the `apple_notes_note_id` setting after the first successful write. By-name search is only a fallback. Why: AppleScript's `every note whose name is X` enumerates writable duplicates in non-deterministic order, so without a stable id-targeted write the same sync would touch different copies each run (see [DD-006](issues.md)).
- The note's name in iCloud is whatever Apple Notes auto-derives from the **body's first line**, NOT what we pass to `make new note`'s `name` property (Apple ignores it). The body's first line and `DEFAULT_NOTE_TITLE` must therefore stay in lockstep — both are `"⚓ DryDock Backlog"`. The renderer enforces this by emitting the title as the body's first line. See [DD-007](issues.md).
- Apple Notes sync is wrapped in an **in-process mutex** (`inFlightSync` in [lib/orchestrator/backlog.ts](lib/orchestrator/backlog.ts)). Concurrent callers (e.g. the /backlog polling timer firing while a manual "Sync Notes" click is mid-osascript) share a single AppleScript run rather than racing.
- `last_apple_notes_sync_at` is **only** stamped after both the read and the write completed without throwing. A partial failure (e.g. read OK but write blocked by permissions) deliberately leaves the timestamp unchanged so the UI keeps showing the older "Synced &lt;when&gt;" rather than misreporting a half-finished round.
- Manual backlog items get `external_id = lineId(title)` stamped at POST time — without that, the next sync's pull treats them as new and mints a duplicate row. The pull also has a **title-claim fallback** that adopts pre-existing null-id manual rows in place. See [DD-008](issues.md).
- **UAT escape hatch:** set `DRYDOCK_PROVIDER_STUB=1` before `npm run dev` and every dispatch resolves to a no-op stub provider that yields a fixed transcript + zero-cost usage event. Use this when you need to walk the Run / Retry / SSE flow without actually shelling out to `claude` or `gemini`. See [.claude/skills/drydock-uat/SKILL.md](.claude/skills/drydock-uat/SKILL.md).

## File map (Phase 1)

```
app/
  layout.tsx                    # PWA meta, dark theme shell, ⚓ wordmark
  page.tsx                      # Dashboard (client). Mounts useAutoSync() one-shot
                                # for the "launch" Apple Notes sync.
  project/[id]/page.tsx         # Project detail + ProjectDocs reader
  discover/page.tsx             # Scan ~/Documents/Projects (DRYDOCK_PROJECTS_ROOT) and one-click import
  backlog/page.tsx              # Cross-project backlog. Inline ✏️ Edit, 🗑️ trash.
                                # useAutoSync({intervalMs: 30_000}) + SyncStatus badge.
  settings/page.tsx             # Toggles for auto-cleanup worktree (+ future settings)
  api/
    projects/route.ts           # GET list, POST create
    projects/[id]/route.ts      # GET, PATCH, DELETE
    projects/[id]/docs/route.ts # GET issues.md / backlog.md / CLAUDE.md etc. inline
    tasks/route.ts              # GET list (with latest_run), POST create
    tasks/running/route.ts      # GET cross-project list of in-flight tasks
    tasks/[id]/route.ts         # GET, PATCH, DELETE (+ runs)
    tasks/[id]/run/route.ts     # POST claim + dispatch
    tasks/[id]/retry/route.ts   # POST move failed -> pending, clear branch
    tasks/[id]/stream/route.ts  # GET SSE stream (uses replayFromDb)
    discover/route.ts           # GET scan a projects-root dir for importable subprojects
    budget/route.ts             # GET monthly-spend rollup; PUT to set budget / ack threshold
    settings/route.ts           # GET, PUT generic allow-listed settings (boolean only)
    backlog/route.ts            # GET list, POST (stamps external_id = lineId(title))
    backlog/[id]/route.ts       # GET, PATCH (title/description/status/project), DELETE
    backlog/[id]/burn/route.ts  # POST burn item into a task in the linked project
    backlog/sync/route.ts       # GET lastSyncedAt; POST bidirectional Apple Notes sync
    backlog/dedupe/route.ts     # POST collapse same-title rows + push consolidated state
    provider-budgets/route.ts   # GET aggregated provider usage (Claude live from session
                                # logs; Codex/Google return null — no public usage API).
                                # In-process 5-min cache.
components/
  ProjectCard.tsx, TaskCard.tsx
  AddProjectModal.tsx, AddTaskModal.tsx
  ProviderBadge.tsx, StatusBadge.tsx, StackChip.tsx
  StreamViewer.tsx              # SSE consumer (client-only)
  ProjectDocs.tsx               # Collapsible reader of project markdown
  BudgetWidget.tsx              # Header pill + banner + Notification API
  RunningTasksPanel.tsx         # Cross-project live-tail "Running now" panel
  SyncStatus.tsx                # "Synced 30s ago" / "Syncing…" / "⚠ Sync failed" badge
  useAutoSync.ts                # Hook: one-shot on mount + optional interval polling
lib/
  api/json.ts                   # tiny ok/created/badRequest/notFound helpers
  db/index.ts                   # connection singleton, schema apply
  db/projects.ts, tasks.ts, runs.ts
  db/settings.ts                # key/value store + getBooleanSetting helper
  db/backlog.ts                 # backlog_items CRUD + getBacklogItemByTitle
  budget/rollup.ts              # monthly spend + threshold logic
  discovery/scan.ts             # filesystem scan for /Projects subdirs + readProjectDocs
  integrations/apple-notes.ts   # osascript wrappers, buildReadScript/buildWriteScript,
                                # parse + render (with `· added YYYY-MM-DD` suffix).
                                # DEFAULT_NOTE_TITLE includes the ⚓ anchor so it
                                # matches Apple's auto-derived note name.
  orchestrator/
    dispatch.ts                 # claim + run + persist + worktree + gate wiring.
                                # Synthesizes the single `exit` event after cleanup.
    hub.ts                      # in-memory pub/sub keyed by runId
    prompt.ts                   # buildAgentPrompt — pure
    worktree.ts                 # per-task `git worktree add` + cleanup
    gate.ts                     # runs project.test_command after agent exits 0
    replay.ts                   # replayFromDb — terminal-run SSE replay
    backlog.ts                  # burn-down + applyPulledLines (incl. 1:1 rename
                                # heuristic) + sync mutex + last-sync-at +
                                # dedupeBacklogItems + Apple Notes id setting
  providers/
    types.ts                    # AgentProvider, AgentEvent (incl. usage variant)
    spawn.ts                    # shared subprocess + readline wrapper
    claude.ts                   # stream-json provider; flattens text + emits usage
    claude-parse.ts             # pure parser for the stream-json line protocol
    claude-usage.ts             # Walks ~/.claude/projects/**/*.jsonl and aggregates
                                # message.usage blocks into weekly (rolling 7d) +
                                # monthly (calendar) token totals. Powers the live
                                # Claude card in Settings → Provider budgets.
    budget-links.ts             # Deep-link targets for Codex / Google AI Pro
                                # (subscriptions with no public usage API).
    gemini.ts                   # gemini -p subprocess wrapper
    index.ts                    # registry
docs/
  plan.md                       # full build plan — DELETE after Phase 3
  setup.md                      # Cloudflare Tunnel + CLI auth
```

## Working agreements

- **Read the file before editing.** Standard CLAUDE.md rule applies.
- **Check [security.md](security.md) before `npm install` (or any package install/upgrade).** It's the supply-chain advisory log. Refresh it if `Last updated` is >7 days stale. Active Mini Shai-Hulud / TeamPCP worm campaigns mean a bad version can land within minutes of a maintainer being phished.
- **Add a vitest test for every bug fix.** Suite is in `lib/**/*.test.ts` and runs sequentially (`fileParallelism: false` because tests use temp SQLite files).
- **Comments only when WHY is non-obvious.** Don't narrate WHAT — names already do that.
- **Mobile first.** If you change UI, resize the preview to 375×812 and verify before declaring done.
- **No API keys anywhere.** If you ever feel the urge to add an `ANTHROPIC_API_KEY` env var, stop — the design is sub-processes only.
- **Touch targets stay 44px+.** See [design.md](design.md).

## Workflow

```bash
npm install            # one-time
npm run dev            # http://localhost:3000
npm run typecheck      # tsc --noEmit, must pass
npm test               # vitest run, must pass
npm run build          # production build, used by CI / before deploy
```

## Where to add new things

| Adding... | Goes in |
|---|---|
| A new provider (e.g. `qwen`) | `lib/providers/<name>.ts` + register in `lib/providers/index.ts` + update `ProviderName` union in `types.ts` |
| A new API route | `app/api/<...>/route.ts` with `export const runtime = "nodejs"` |
| A DB column | Update [lib/db/schema.sql](lib/db/schema.sql), the matching CRUD module, AND add an `ensure(...)` call in `migrate()` ([lib/db/index.ts](lib/db/index.ts)) so existing DBs pick it up |
| A new global setting | Add the key constant somewhere it can be imported; add an entry to the `WRITABLE` allow-list in [app/api/settings/route.ts](app/api/settings/route.ts) if it should be user-toggleable; read via `getBooleanSetting` / `getNumberSetting` / `getSetting` |
| A new UI component | `components/<Name>.tsx`; consult [design.md](design.md) before picking colors/spacing |
| A new test | Colocate next to the module: `lib/foo/foo.test.ts` (the include glob is `lib/**/*.test.ts`) |

## Settings keys (single-row each in the `settings` table)

| Key | Set by | Used by |
|---|---|---|
| `monthly_budget_usd` | `PUT /api/budget` | `BudgetWidget`, threshold-banner logic |
| `last_budget_alert_pct` | `PUT /api/budget` with `acked_pct` | Suppresses re-alert until next threshold |
| `apple_notes_title` | `PUT /api/backlog/sync` body `notesTitle` | Lookup name for the canonical note. Auto-migrates `"DryDock Backlog"` → `"⚓ DryDock Backlog"` on read. |
| `apple_notes_note_id` | Auto, after first successful write | Stable id targeting on every read/write so concurrent duplicates don't rotate. |
| `apple_notes_last_sync_at` | Auto, after a fully-successful sync | `SyncStatus` badge + `useAutoSync` UI. |
| `auto_cleanup_worktree` | `PUT /api/settings` | Dispatcher tears down the per-task worktree after a successful run + passing gate. |

## Apple Notes conflict resolution (cheat sheet)

Documented at length in [lib/orchestrator/backlog.ts](lib/orchestrator/backlog.ts) JSDoc for `syncWithAppleNotes` and `applyPulledLines`. Summary:

| Scenario | Resolution |
|---|---|
| Add in Notes only | Pull creates row |
| Add in UI only | POST stamps `external_id = lineId(title)`; push writes the line |
| Add in both, same title | Same line key → single row, no-op |
| Check in Notes | DB → `done` (irreversible — un-check in Notes does NOT re-open) |
| Mark done in UI | Pushes `[x]` to note |
| Delete line in Notes | Ignored — re-added on next push (Notes deletion is one-tap; we don't let it nuke state). Items removed via DryDock UI use DELETE → row gone everywhere. |
| Edit title in UI | PATCH; title-claim fallback re-stamps `external_id` on next pull |
| Edit title in Notes | Detected via 1:1 orphan/new-line heuristic in `applyPulledLines` — same DB row, new title + external_id. Multi-edit windows skip the heuristic and treat lines as creates. |
| Concurrent syncs | `inFlightSync` mutex collapses to one |
| Apple Notes offline / unauthorized | Sync route returns structured 500; `SyncStatus` shows ⚠; rest of UI keeps working |

## What lives outside this repo

- DB file: `~/.drydock/drydock.db`
- Per-task worktrees: `~/.drydock/worktrees/<projectId>/<taskId>/` (Phase 2; kept on success so the user can inspect/PR)
- Project discovery root: `~/Documents/Projects` by default. Override with `DRYDOCK_PROJECTS_ROOT` env var.
- Claude OAuth session: `~/.claude/`
- Claude Code session logs: `~/.claude/projects/<dash-encoded-cwd>/<sessionId>.jsonl` — read (numeric aggregation only, no content) by `lib/providers/claude-usage.ts` for the Settings → Provider budgets Claude card. Never write back.
- Gemini OAuth session: `~/.gemini/`
- Cloudflare Tunnel credentials JSON: `~/.cloudflared/<UUID>.json`

None of those should ever appear in `git diff`.
