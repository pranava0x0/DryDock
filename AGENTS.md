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
- SSE event flow: dispatcher publishes to [lib/orchestrator/hub.ts](lib/orchestrator/hub.ts) → the `/api/tasks/[id]/stream` route subscribes via `subscribe(runId)`. If the run is already terminal, the route replays from the `runs` row instead (see [DD-001/DD-002](issues.md)).
- Schema migrations run automatically on every DB open via `migrate()` in [lib/db/index.ts](lib/db/index.ts). New columns must be added through `ensure(table, col, ddl)` calls there, NOT only in `schema.sql` — existing Phase 1/2 DBs won't pick up `CREATE TABLE IF NOT EXISTS` changes.
- Claude provider runs `--output-format stream-json --verbose`. Each stdout line is one JSON event. [claude-parse.ts](lib/providers/claude-parse.ts) flattens `assistant` events into text and turns the final `result` event into a structured `usage` AgentEvent variant — that's how `runs.tokens_in/out` and `runs.cost_usd` get populated.
- **UAT escape hatch:** set `DRYDOCK_PROVIDER_STUB=1` before `npm run dev` and every dispatch resolves to a no-op stub provider that yields a fixed transcript + zero-cost usage event. Use this when you need to walk the Run / Retry / SSE flow without actually shelling out to `claude` or `gemini`. See [.claude/skills/drydock-uat/SKILL.md](.claude/skills/drydock-uat/SKILL.md).

## File map (Phase 1)

```
app/
  layout.tsx                    # PWA meta, dark theme shell, ⚓ wordmark
  page.tsx                      # Dashboard + "Discover" link (client)
  project/[id]/page.tsx         # Project detail + ProjectDocs reader
  discover/page.tsx             # Scan ~/Documents/Projects (DRYDOCK_PROJECTS_ROOT) and one-click import
  backlog/page.tsx              # Global cross-project backlog with Apple Notes sync
  api/
    projects/route.ts           # GET list, POST create
    projects/[id]/route.ts      # GET, PATCH, DELETE
    projects/[id]/docs/route.ts # GET issues.md / backlog.md / CLAUDE.md etc. inline
    tasks/route.ts              # GET list (with latest_run), POST create
    tasks/[id]/route.ts         # GET, PATCH, DELETE (+ runs)
    tasks/[id]/run/route.ts     # POST claim + dispatch
    tasks/[id]/retry/route.ts   # POST move failed -> pending, clear branch
    tasks/[id]/stream/route.ts  # GET SSE stream
    discover/route.ts           # GET scan a projects-root dir for importable subprojects
    budget/route.ts             # GET monthly-spend rollup; PUT to set budget / ack threshold
    backlog/route.ts            # GET list, POST create global backlog items
    backlog/[id]/route.ts       # GET, PATCH, DELETE
    backlog/[id]/burn/route.ts  # POST burn item into a task in the linked project
    backlog/sync/route.ts       # POST bidirectional Apple Notes sync
components/
  ProjectCard.tsx, TaskCard.tsx
  AddProjectModal.tsx, AddTaskModal.tsx
  ProviderBadge.tsx, StatusBadge.tsx, StackChip.tsx
  StreamViewer.tsx              # SSE consumer (client-only)
  ProjectDocs.tsx               # Collapsible reader of project markdown
  BudgetWidget.tsx              # Header pill + banner + Notification API
lib/
  discovery/scan.ts             # filesystem scan for /Projects subdirs + readProjectDocs
  db/settings.ts                # key/value store (budget, notes title, last alert)
  db/backlog.ts                 # backlog_items CRUD
  budget/rollup.ts              # monthly spend + threshold logic
  integrations/apple-notes.ts   # osascript wrappers + parse/render
  orchestrator/backlog.ts       # burn-down + bidirectional Apple Notes sync
lib/
  api/json.ts                   # tiny ok/created/badRequest/notFound helpers
  db/index.ts                   # connection singleton, schema apply
  db/projects.ts, tasks.ts, runs.ts
  orchestrator/
    dispatch.ts                 # claim + run + persist + worktree + gate wiring
    hub.ts                      # in-memory pub/sub keyed by runId
    prompt.ts                   # buildAgentPrompt — pure
    worktree.ts                 # per-task `git worktree add` + cleanup (Phase 2)
    gate.ts                     # runs project.test_command after agent exits 0 (Phase 3)
  providers/
    types.ts                    # AgentProvider, AgentEvent (incl. usage variant)
    spawn.ts                    # shared subprocess + readline wrapper
    claude.ts                   # stream-json provider; flattens text + emits usage
    claude-parse.ts             # pure parser for the stream-json line protocol
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
| A new UI component | `components/<Name>.tsx`; consult [design.md](design.md) before picking colors/spacing |
| A new test | Colocate next to the module: `lib/foo/foo.test.ts` |

## What lives outside this repo

- DB file: `~/.drydock/drydock.db`
- Per-task worktrees: `~/.drydock/worktrees/<projectId>/<taskId>/` (Phase 2; kept on success so the user can inspect/PR)
- Project discovery root: `~/Documents/Projects` by default. Override with `DRYDOCK_PROJECTS_ROOT` env var.
- Claude OAuth session: `~/.claude/`
- Gemini OAuth session: `~/.gemini/`
- Cloudflare Tunnel credentials JSON: `~/.cloudflared/<UUID>.json`

None of those should ever appear in `git diff`.
