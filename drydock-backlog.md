# DryDock — Backlog

Product backlog for the DryDock orchestrator app. The portfolio-level [BACKLOG.md](BACKLOG.md) covers cross-project work; this file is just DryDock features.

## Active Backlog

| ID | Feature | Priority | Complexity | Size | Impact | Status |
|---|---|---|---|---|---|---|
| DD-BL-06 | Optional Turso migration for the DB so the same orchestrator state is accessible from a phone-side hosted version. | P3 | complex | L | Removes Mac-on-network dependency. Genuinely free up to 9 GB / 500 DBs. | Not Started |
| DD-BL-13 | Cost rollup on the dashboard — per-project total $ spent across runs. | P3 | simple | S | Lets the user see usage cost without drilling into individual tasks. | Not Started |
| DD-BL-14 | Persist gate output in the StreamViewer "View output" replay so the user can inspect why the gate failed. | P2 | simple | S | Today gate failure is summarized to one line in the transcript. | Not Started |
| DD-BL-07 | Auth on the Cloudflare Tunnel entrypoint (Cloudflare Access policy). Currently anyone with the URL can dispatch agents on the Mac. | P1 | simple | S | Closes the open hole before the URL is shared anywhere. | Not Started |
| DD-BL-08 | Streaming JSON output mode for Claude (`--output-format stream-json`) so we can show structured events (tool calls, file edits) instead of raw stdout. | P2 | moderate | M | Better UX than a terminal dump — show which file the agent is editing right now. | Not Started |
| DD-BL-09 | Live-tail "running tasks" list on the dashboard — surfaces in-flight work across all projects without drilling into each. | P2 | simple | S | Lets the user notice when something's stuck. | Not Started |
| DD-BL-10 | Optional auto-pull / auto-merge of the agent's branch when its run finishes successfully and quality gates pass. | P3 | moderate | M | Closes the trust loop for low-risk tasks (typos, lint fixes). | Not Started |
| DD-BL-11 | Optional auto-cleanup of merged worktrees (today every successful task leaves a worktree on disk). | P2 | simple | S | Disk hygiene; today users have to `git worktree remove` by hand. | Not Started |
| DD-BL-12 | Auto-create-PR step (`gh pr create`) after the agent exits 0 inside an isolated worktree. | P2 | moderate | M | Skips the manual `git push` + GitHub-UI flow for one-off tasks. | Not Started |
| DD-BL-13 | Per-provider budget rollup (split claude vs gemini spend) on the budget pill. | P3 | simple | S | Today both providers' costs are pooled — splitting would make it easier to see which agent is eating the budget. | Not Started |
| DD-BL-14 | Weekly digest of cost + burn-down activity via email (Resend free tier) or local launchd job. | P3 | moderate | M | Closes the loop when the user is away from the PWA. | Not Started |
| DD-BL-15 | True Web Push (service worker + VAPID) so threshold alerts fire when DryDock isn't open. Free but moderate setup. | P3 | moderate | M | The current Notification API only works while a tab is open. | Not Started |
| DD-BL-16 | Sync the budget rollup against the Anthropic subscription's actual usage cap (when/if surfaced by `claude` CLI). | P3 | simple | S | Today we track observed cost only — would let the user see "X% of subscription limit." | Not Started |
| DD-BL-17 | Two-way conflict UI for Apple Notes sync (when the note and DB diverge mid-edit). | P3 | moderate | M | Today DB silently wins on push; user can lose a note-side edit if they don't pull first. | Not Started |
| DD-BL-18 | Reorder backlog items by drag (priority field exists, no UI yet). | P3 | simple | S | Today priority is set via API only. | Not Started |

## Shipped Summary

| Phase | Description | Commit |
|---|---|---|
| 1 | DryDock orchestrator core: Next.js 15 App Router, SQLite (better-sqlite3), Claude+Gemini CLI providers, atomic task claim, SSE event streaming, mobile-first PWA UI. 43 unit tests across DB, providers, hub, dispatcher. | 7f42545 |
| 2 | Git worktree isolation per task — `lib/orchestrator/worktree.ts`, dispatcher wiring (branch + `worktree_path` persisted on task row), `TaskCard` surfaces branch + PR URL, graceful fallback when the project isn't a git repo or worktree setup fails. 12 new tests (10 worktree + 2 dispatch integration). | 1a2194b |
| 3 | Phase 3 polish: project-level `test_command` quality gate that demotes "agent done" to "failed" on test-suite failure; claude `--output-format stream-json --verbose` parsing for tokens + cost (`tokens_in/out`, `cost_usd` on `runs`); one-tap Retry on failed task cards; idempotent ALTER-TABLE migration so existing Phase 1/2 DBs upgrade in place. Cost + gate verdict surface inline on `TaskCard`. 19 new tests (gate runner, claude line parser, dispatch integration for gate / cost capture, migration round-trip). | a125cb6 |
| - | Kraken color palette + ⚓ anchor / 🏗️ crane motif end to end; `DRYDOCK_PROVIDER_STUB=1` env var for token-free dispatch in dev; `.claude/skills/drydock-uat/SKILL.md` (project-specific UAT skill, perf + data-efficiency audits, three-viewport rhythm); `.claude/skills/launch/SKILL.md` (`launch` slash trigger to bring the dev server up). | 0017a14 / 4be2fa6 |
| - | Project discovery + doc viewer: `/discover` page scans `~/Documents/Projects` (or `DRYDOCK_PROJECTS_ROOT`) and lets the user one-click import any subdir, with stack-detection chips (next / node / python / rust / go / ruby / php / vite / pnpm) and git detection. Project detail pages get a collapsible "Project docs" panel that lazy-loads `issues.md` / `backlog.md` / `drydock-backlog.md` / `CLAUDE.md` / `AGENTS.md` / `design.md` / `README.md` per project. 9 new tests for scan + read. | 424d2f3 |
| - | Budget rollup + threshold notifications. `settings` key/value table; `GET/PUT /api/budget`; header `BudgetWidget` pill that ramps ice→amber→alert at 50/80/100% with an inline banner + browser Notification on threshold crossing. 9 new tests. | 532eff7 |
| - | Global cross-project backlog with Apple Notes sync. `backlog_items` table (project_id nullable, source manual/apple-notes, task_id pointer); CRUD API + burn-down endpoint that creates a Pending task in the linked project; `/backlog` page with status filters, project assignment dropdown, burn-down + drop/done actions; Apple Notes integration via `osascript` reading + writing a single canonical note (default "DryDock Backlog"); auto-push on every mutation, manual full sync via "↻ Sync Notes" button. 21 new tests (CRUD, burn-down, parser, render, round-trip, FK SET NULL). | _pending commit_ |
