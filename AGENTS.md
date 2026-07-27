# DryDock — Notes for AI Agents

This file is read by AI agents (Claude Code, Gemini CLI) when they start working inside the DryDock repository. Keep it tight — every line here costs context.

## What DryDock is

A personal project orchestrator. It dispatches coding tasks to Claude Code / Gemini CLI subprocesses and shows the live stdout in a mobile-first PWA. There is no API key — providers authenticate via OAuth sessions on the host Mac (`~/.claude/`, `~/.gemini/`).

## Tech invariants

- Next.js 15 App Router, TypeScript strict, Tailwind 3, React 19.
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
- **UAT escape hatch:** set `DRYDOCK_PROVIDER_STUB=1` before `npm run dev` and every dispatch resolves to a no-op stub provider that yields a fixed transcript + zero-cost usage event. Use this when you need to walk the Run / Retry / SSE flow without actually shelling out to `claude` or `gemini`. Add `DRYDOCK_PROVIDER_STUB_DELAY_MS=10000` to hold each stub run open so the queued/running/Stop states are actually observable (the wait is abort-aware, so cancel works against it). See [.claude/skills/drydock-uat/SKILL.md](.claude/skills/drydock-uat/SKILL.md).
- **Remote-access auth (EP-1).** The Cloudflare Tunnel URL is guarded by [middleware.ts](middleware.ts). `localhost` requests bypass auth **only** when no Cloudflare headers (`cf-ray`/`cf-connecting-ip`) are present — a spoofed `Host: localhost` through the tunnel still carries them, so the bypass can't be forged. Two modes, resolved from env in [lib/auth/decide.ts](lib/auth/decide.ts): Cloudflare Access (`CF_ACCESS_TEAM_DOMAIN`+`CF_ACCESS_AUD`, JWT verified against JWKS in [lib/auth/cf-access.ts](lib/auth/cf-access.ts), WebCrypto-only so it runs on the edge runtime) or a shared `DRYDOCK_AUTH_TOKEN` (Bearer header or the httpOnly `drydock_auth` cookie set by `/auth`). **Neither configured → every non-local request is denied (fail closed).** The decision logic is pure and fully tested; keep new secrets out of it. **The `localhost` bypass is only sound because the server binds loopback** (`next dev/start -H 127.0.0.1` in [package.json](package.json)) — it trusts the forgeable `Host` header, so widening the bind back to `0.0.0.0` would let a LAN peer reach the origin with `Host: localhost` and skip auth (DD-015). Two smaller hardenings there too: JWKS cache misses refetch at most once per 60s (bounds an unknown-`kid` flood), and the `drydock_auth` cookie's `Secure` flag is derived from the request host, not the client-settable `x-forwarded-proto`.
- **`ACTIVE_RUNS` is an in-process singleton and only works in a production server.** Cancel (`POST /api/tasks/[id]/cancel` → `cancelActiveRun`) and SSE-disconnect handling both look up the live `AbortController` in the `ACTIVE_RUNS` map in [lib/orchestrator/dispatch.ts](lib/orchestrator/dispatch.ts). In `next dev`, route handlers can get **separate module instances**, so a cancel dispatched from `/cancel` may not see the controller the `/run` route registered — cancel no-ops and returns `alreadyTerminal`. This is a dev-mode artifact, **not a bug**: verify cancel/queue-drain against `npm run build && npm run start` (single server instance), where it works. See [DD-009](issues.md).
- **A dropped SSE connection must NOT kill the run.** [app/api/tasks/[id]/stream/route.ts](app/api/tasks/%5Bid%5D/stream/route.ts) aborts only its own subscription on client disconnect — never the subprocess. Phone clients disconnect constantly (lock screen, app switch, tunnel blips); stopping an agent is an explicit action via the cancel endpoint. Reverting this to "abort the child on disconnect" reintroduces the phone-kills-agent bug — regression-pinned in `lib/orchestrator/stream-route.test.ts`.
- **Concurrency cap + queue.** `POST /run` goes through `runTaskWithCap`: under the `max_concurrent_runs` cap (setting, default 3) it claims a slot and dispatches; at the cap it CAS-moves the task `pending → queued` and returns **202** `{queued, position}`. The count-and-claim is one DB transaction (`claimTaskRespectingCap`) so parallel `/run` calls can't both squeeze past the cap — the invariant is in the DB, not the button. Run finalization calls `drainQueue`, which pulls queued tasks FIFO (`nextQueuedTask`, ordered by `updated_at, rowid`). `queued` is a real task status persisted in SQLite, so the queue survives a server restart. **`/followup` routes through the same cap** — a resumable follow-up can't jump the queue (DD-011). **In-flight rows stranded by a restart** (`claimed`/`running` tasks + `running` runs whose in-memory controllers died) are reconciled to `failed` once per process at `getDb()` (`reconcileInterruptedRuns`, [lib/db/index.ts](lib/db/index.ts)) — otherwise they'd count against the cap forever and wedge the queue (DD-013).
- **Autonomy profiles set the agent's blast radius per project.** `projects.autonomy` (`readonly`|`edits`|`full`, default `edits`) maps to explicit claude flags in [lib/providers/claude.ts](lib/providers/claude.ts) `autonomyArgs` — `readonly`→`--permission-mode plan`, `edits`→`acceptEdits` + a narrow Bash allowlist (tests/typecheck/read-only git), `full`→`acceptEdits` + unrestricted Bash. **Never emits `--dangerously-skip-permissions`** (banned on the host per `vibe-coding-security/prevention`). The decision lives in versioned code, not the host's `~/.claude/settings.json`. Gemini ignores it (no per-invocation permission flags); Codex mapping is future work.
- **Tasks are threads (EP-2).** A run captures the provider session id (`runs.session_id`) from claude's stream-json `init` event (parsed in [claude-parse.ts](lib/providers/claude-parse.ts) as a `session` AgentEvent — internal plumbing, never forwarded to SSE). `followUpTask` ([dispatch.ts](lib/orchestrator/dispatch.ts)) continues a **terminal** task by `claude -p --resume <session_id>` in the same worktree (reused if still attached, else re-attached from the surviving branch via `recreateWorktree`), writing a new `runs` row with `parent_run_id` set. `completeRun` persists `session_id ?? resumeSessionId`, so a follow-up that dies before Claude emits a fresh session id keeps the parent thread resumable instead of nulling it (DD-014); `createWorktree` uses `-B` + a prune/remove so re-attaching over a failed task's leftover branch can't collide and silently drop the agent into the project checkout (DD-012). Follow-ups do **not** re-run routing rules — steering stays on the parent run's provider so a rule can't silently switch models mid-thread. `POST /api/tasks/[id]/followup` resumes when a session exists; with no session (gemini, or a run that died before init) it falls back to a fresh run for a *failed* task, folding the feedback into the task description (`resumed:false`). Mid-run interactivity (answering prompts while the agent is live) is deliberately **out of scope** — follow-ups are post-run only.
- **`dispatchTask` and `followUpTask` share `runAndFinalize`.** The run loop / gate / auto-cleanup / cancel / failure-reason / queue-drain logic lives once in `runAndFinalize`; the two entry points differ only in how they resolve the worktree (`resolveWorktree` callback) and whether they pass `resumeSessionId`. Don't fork this — a change to gate or cancel semantics must stay identical for first runs and follow-ups.
- **Dependency installs are script-disabled — with exactly one vetted exception.** Install per `vibe-coding-security/prevention/npm-hardening.md`: `npm install --ignore-scripts` (or `npm ci --ignore-scripts`). That skips `better-sqlite3`'s `prebuild-install`, so the native binding goes missing and every DB test fails with "Could not locate the bindings file". Follow every install with `npm rebuild better-sqlite3 --foreground-scripts` — it's the one dependency here that genuinely needs its install script, and running it in the foreground means you'd see anything unexpected it did. Don't "fix" the failure by dropping `--ignore-scripts`. `next` is pinned **exactly** (no `^`) so a security batch is a deliberate upgrade, not a silent resolve (DD-016).
- **The usage ledger's days are LOCAL, and collectors REPLACE a range rather than upserting.** Every provider writes UTC ISO timestamps, but "what did I use on Tuesday" is a question about the user's calendar — `toISOString().slice(0,10)` is the UTC answer in local clothing and files evening work on the wrong day. All conversion goes through [lib/util/day.ts](lib/util/day.ts), whose arithmetic is DST-safe. Collectors then call `replaceUsageDailyRange` (delete from the cursor day forward, reinsert, one transaction) instead of a plain upsert: an upsert can only add or overwrite, so a model the user stopped using would keep its row and every total would keep counting it. That's only sound because of the mtime pre-filter's guarantee — a file older than the cursor can't hold a turn after it — so **changing the pre-filter breaks the ledger**. The cursor advances to *yesterday*, not today, because a 23:59:58 turn can be flushed after midnight.
- **There is exactly ONE Claude JSONL walker for the ledger.** [lib/connectors/claude-scan.ts](lib/connectors/claude-scan.ts) emits usage rows, session boundaries, and `pr-link` records in a single pass over the same 1.3 GB. A second walker would double the cold-read cost of the most expensive thing DryDock reads and let the two drift on what counts as a turn. Need a third thing? Add it to `ScanResult`. (`lib/providers/claude-usage.ts` is untouched and answers a different question — rolling 5h/weekly windows at a granularity days can't express.)
- **Never render a confident wrong value — the ledger has four specific traps.** (1) Google records **no token counts anywhere**; its rows carry `events` and zeroed token columns, so `tokensAreReal` gates every surface and a Google row must never be summed into a token total. (2) A provider with no data reports *why* (`unavailable` + reason), never a zero — health describes the **source**, not the incremental slice, or an empty overnight collect badges a card showing 312M tokens. (3) An unpriced model contributes $0 **and** drags a rendered `coverage` figure; `claude-fable-5` has no published price and dominates these logs. (4) A quota percentage always renders its age.
- **Commit attribution keys on the `noreply@` DOMAIN, not the trailer name.** Human `Co-authored-by:` trailers are common in these repos (pair commits, rebases, a second machine's git identity), so "has a trailer → AI" over-counts badly. Match `noreply@anthropic.com` / `noreply@openai.com`, case-insensitively (tool versions wrote both `Co-Authored-By` and `Co-authored-by`). Branch prefixes are a *weaker* fallback, so every AI-share number renders its **trailer coverage** beside it. [lib/insights/attribution.ts](lib/insights/attribution.ts).
- **`/api/flow` reads local git clones, not the GitHub API.** Attribution needs full commit message bodies — that's where trailers live, and `gh search` doesn't reliably return them, so the API path yields no model breakdown at all. Local clones also make private repos a non-question and cost no rate limit. The trade (repos not cloned here are invisible) is stated in the UI.
- **The inbox is the seam that keeps the backlog trustworthy.** `backlog_items.triaged_at IS NULL` = captured, not accepted. Every inbound feeder goes through [lib/orchestrator/intake.ts](lib/orchestrator/intake.ts) — never straight to `createBacklogItem` — so parsing, dedup, and the never-drop guarantee are written once. **Inbox rows never reach the Apple Note**; only accepted ones do, which is what keeps the Notes sync bit-for-bit unchanged. `manual` and `apple-notes` land pre-triaged (typing into a trusted surface is already deliberate); everything else waits. Dedup **never drops**: only an exact title match counts as the same item, and a near-match is inserted with a "possibly similar to" note — a swallowed idea is unrecoverable, an extra inbox row costs one tap.
- **Capture markers are TRAILING-ONLY, and `p1` is the HIGHEST priority value.** "fix the #2 bug in p1 mode" is a title, not a project called "2". And `backlog_items.priority` sorts DESC, so p1 → 3; inverting that files every urgent capture at the bottom of the list.
- **A migration that adds a NULL-means-something column needs a done-marker.** `triaged_at IS NULL` means "in the inbox", so the backfill stamping pre-existing rows must run **once** — `migration.backlog_triaged_at_backfilled` in `settings`. Without it, every process restart re-stamps genuinely-untriaged rows and silently empties the inbox into the backlog. Both directions are regression-pinned in `intake.test.ts`.
- **Long collects don't block a page load.** The first usage collect took **83 seconds** here (270 recent session logs the mtime filter can't skip). `/api/usage` starts the walk and answers from the ledger as it stands (~140ms), reporting `collecting` so the UI says "still reading your logs" instead of rendering a cold ledger's zeros as fact. `/api/flow` caches its ~8s sweep for 5 minutes.
- **The MCP tool surface is an allowlist per caller, not a denylist.** `TOOLS_BY_CALLER` in [lib/mcp/tools.ts](lib/mcp/tools.ts): the `ai-generated` caller (the nightly ideas session, which reads untrusted web content) gets `add_backlog_item` and **nothing else**. Withholding `dispatch_task` alone was not enough — `list_backlog`/`list_tasks`/`get_usage_stats` pull private local state into a context that already has attacker-controlled input *and* its own web access to exfiltrate through, and `burn_down_item` mutates. Allowlist, so forgetting to classify a new tool makes it unavailable rather than silently reachable; and it gates `tools/call`, not just `tools/list`. Caller identity comes from `DRYDOCK_MCP_CALLER` and defaults to the *less* trusted value.
- **`attributedBody` is the main path for iMessage, not a fallback.** 52% of messages on this Mac (497,612 of 949,169) have a NULL `text` column. [lib/integrations/typedstream.ts](lib/integrations/typedstream.ts) decodes the NSAttributedString; it was validated against 4,000 messages carrying both fields (4,000 exact matches, 0 mismatches) and that check is the thing to re-run if the format ever moves. A message it can't decode still becomes a visible inbox row — silently skipping loses a thought with no trace. **Full Disk Access is inherited from the launching terminal**, so a launchd-managed DryDock loses it; `imessageHealth()` probes by querying, not by `stat`, because the file is visible without FDA and only the read fails.
- **No scheduled scraping of consumer chat surfaces, ever.** Anthropic's consumer terms prohibit accessing claude.ai "through automated or non-human means" and OpenAI's carry an equivalent clause. `/api/usage/observations` therefore accepts `manual` and `browser` only — a human-in-the-loop reading — and cannot be told it came from `app-server` or `stats-cache`, which would let a caller forge a machine-verified figure. Web-chat usage comes from official **exports** instead ([lib/connectors/usage-imports.ts](lib/connectors/usage-imports.ts)); format detection sniffs the payload shape, because Anthropic and OpenAI both ship a file named `conversations.json`.
- **A digest reply that doesn't parse cleanly executes NOTHING.** [lib/insights/digest.ts](lib/insights/digest.ts) `parseReply` collects anything unrecognized, and `replyIsExecutable` refuses the whole reply if there is any — plus any number the digest didn't offer. This runs on text typed one-handed from a lock screen against a real backlog: partial execution of a garbled command is the worst outcome, because the user can't tell which half ran.
- **"Latest run" needs a rowid tiebreak.** `getLatestRunForTask` / `listRunsForTask` order by `started_at DESC, rowid DESC`. `started_at` is `unixepoch()` **seconds**, so a follow-up created in the same second as its parent ties on `started_at`; without the `rowid` tiebreak the SSE route (which streams `getLatestRunForTask`) would show the *parent* run after a follow-up. Same class as the queue's FIFO tiebreak. See [DD-010](issues.md).

## File map

```
app/
  layout.tsx                    # PWA meta, dark theme shell, ⚓ wordmark
  page.tsx                      # Dashboard (client). Mounts useAutoSync() one-shot
                                # for the "launch" Apple Notes sync.
  project/[id]/page.tsx         # Project detail + ProjectDocs reader
  analytics/page.tsx            # Run analytics: stat boxes, 30-day trend, failure breakdown (DD-BL-33)
  auth/page.tsx                 # Token-mode login (middleware redirect target, EP-1)
  discover/page.tsx             # Scan ~/Documents/Projects (DRYDOCK_PROJECTS_ROOT) and one-click import
  backlog/page.tsx              # Cross-project backlog. Inline ✏️ Edit, 🗑️ trash.
                                # useAutoSync({intervalMs: 30_000}) + SyncStatus badge.
  settings/page.tsx             # Auto-cleanup worktree toggle + Provider budgets panel
                                # (Claude + Codex read live token usage from their local
                                # CLI session logs; Google shows Antigravity activity
                                # counts — turns, not tokens; every card keeps an
                                # "Open ↗" deep link). Budget refresh schedule:
                                # throttle-gated (≤1/min) interaction triggers (mount,
                                # click, scroll, visibilitychange) + idle-backoff ticker
                                # (60s, doubling to 30min cap, reset by activity).
                                # See lib/util/{throttle-gate,idle-backoff}.
  analytics/page.tsx            # Tab shell: Runs | Usage | Flow (EP-10/EP-11)
  api/
    analytics/route.ts          # GET computed run/cost analytics summary (DD-BL-33)
    usage/route.ts              # GET the usage ledger; collects in the BACKGROUND
                                # (first walk is ~83s) and reports `collecting`
    flow/route.ts               # GET commit/attribution flow from local git clones
    subscriptions/route.ts      # GET/PUT plan facts; always source='manual'
    capture/route.ts            # POST the five-second capture door → inbox
    backlog/github/route.ts     # GET open PRs+issues; ?import=1 files issues
    backlog/import/route.ts     # POST pull every project's own backlog.md
    backlog/[id]/triage/route.ts # POST accept an inbox item into the backlog
    auth/route.ts               # POST token login (sets httpOnly cookie) / DELETE logout (EP-1)
    routing-rules/route.ts      # CRUD dispatch routing rules (DD-BL-32; UI currently hidden, DD-BL-35)
    projects/route.ts           # GET list, POST create
    projects/[id]/route.ts      # GET, PATCH, DELETE
    projects/[id]/docs/route.ts # GET issues.md / backlog.md / CLAUDE.md etc. inline
    tasks/route.ts              # GET list (with latest_run), POST create
    tasks/running/route.ts      # GET cross-project list of in-flight tasks
    tasks/[id]/route.ts         # GET, PATCH, DELETE (+ runs)
    tasks/[id]/run/route.ts     # POST claim + dispatch (202 + queue at the cap)
    tasks/[id]/cancel/route.ts  # POST stop a running task / un-queue a queued one
    tasks/[id]/followup/route.ts# POST continue a finished task (--resume the session)
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
    provider-budgets/route.ts   # GET aggregated provider usage — Claude + Codex token
                                # totals and Google activity counts, all read live from
                                # local logs (each reader degrades to zeros or an error
                                # object). In-process 60s cache, aligned with the
                                # Settings page's client-side throttle gate.
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
  connectors/                   # EP-10/11 read-only gatherers → rollup tables
    types.ts                    #   Connector iface + registry keys + health
    watermark.ts                #   settings-backed cursors (`connector.<key>.*`)
    claude-scan.ts              #   THE single Claude JSONL walker (usage+sessions+pr-links)
    codex-scan.ts               #   per-day/model/project; model from turn_context
    antigravity-scan.ts         #   activity events only — Google logs no tokens
    usage-connectors.ts         #   the three collectors + TTL/mutex/health
    quota{,-codex,-claude}.ts   #   live cap-% from sanctioned local surfaces
    git-flow.ts                 #   local `git log` sweep → attributed commits
    github-work.ts              #   open PRs/issues via the `gh` CLI
    github-issues-intake.ts     #   issues → backlog (pre-triaged)
    project-backlogs.ts         #   each project's own backlog.md → inbox
  insights/                     # pure read-models over the stores
    api-prices.ts               #   API-equivalent value + coverage honesty
    usage-summary.ts            #   Usage tab payload incl. fleet totals
    attribution.ts              #   who wrote this commit (domain-keyed)
    flow-summary.ts             #   Flow tab payload (5-min cache)
  orchestrator/
    capture.ts                  #   marker parsing + Jaccard dedup (pure)
    intake.ts                   #   the ONE door into the inbox
  util/day.ts                   # local-day keys; DST-safe. All day math here.
  api/json.ts                   # tiny ok/created/badRequest/notFound helpers
  util/throttle-gate.ts         # leading-edge throttle gate (closure + injectable
                                # clock). Used by /settings to keep interaction-
                                # triggered budget refreshes to at most once / 60s.
  util/idle-backoff.ts          # Exponential-backoff idle ticker. Pairs with the
                                # throttle gate above — backoff decides *when to
                                # try*, throttle decides *whether to fetch*.
                                # resetAndArm() on activity puts the ramp back at
                                # base (60s) and re-arms.
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
                                # message.usage blocks into 5h + weekly (rolling 7d)
                                # + monthly (calendar) token totals. Powers the live
                                # Claude card in Settings → Provider budgets.
    codex-usage.ts              # Walks ~/.codex/sessions/**/*.jsonl rollout logs and
                                # sums per-turn last_token_usage deltas from
                                # token_count events into weekly + monthly token
                                # windows (no 5h window). Powers the live Codex card.
    gemini-usage.ts             # Walks ~/.gemini/antigravity/brain/<conv>/
                                # .system_generated/logs/*.{jsonl,txt} step logs and
                                # counts activity (prompts, model turns, tool calls)
                                # into weekly + monthly windows — Antigravity records
                                # no token counts on disk. Powers the Google card.
    usage-mtime.ts              # Shared mtime pre-filter for the three usage readers:
                                # skips files last written before the widest window
                                # cutoff (12h safety margin, provably lossless).
    codex-usage.test.ts         # Fixture-dir tests for the Codex reader (window
                                # cutoffs, delta-vs-cumulative, malformed lines).
    gemini-usage.test.ts        # Fixture-dir tests for the Antigravity reader
                                # (step-type counting, txt + jsonl, missing root).
    budget-links.ts             # Deep-link targets behind every card's "Open ↗"
                                # button (these subscription tiers have no public
                                # usage API).
    gemini.ts                   # gemini -p subprocess wrapper
    index.ts                    # registry
docs/
  improvement-plan-2026-07.md   # EP-1..9 roadmap (EP-1/EP-2 shipped; EP-3+ next)
  analytics-capture-plan-2026-07.md  # EP-10..15 telemetry/capture/linkage track
  setup.md                      # Cloudflare Tunnel + CLI auth
```

## Working agreements

- **Read the file before editing.** Standard CLAUDE.md rule applies.
- **Check [`pranava0x0/vibe-coding-security`](https://github.com/pranava0x0/vibe-coding-security) before `npm install` (or any package install/upgrade).** No local `security.md` exists in this repo (see [CLAUDE.md](CLAUDE.md)) — the GitHub repo is the live source. Fetch `https://pranava0x0.github.io/vibe-coding-security/llms-ctx.txt` and cross-check the lockfile against the relevant `advisories/*.md`. Active Mini Shai-Hulud / TeamPCP worm campaigns mean a bad version can land within minutes of a maintainer being phished.
- **Add a vitest test for every bug fix.** Suite is in `lib/**/*.test.ts` and runs sequentially (`fileParallelism: false` because tests use temp SQLite files).
- **Comments only when WHY is non-obvious.** Don't narrate WHAT — names already do that.
- **Mobile first.** If you change UI, resize the preview to 375×812 and verify before declaring done.
- **No API keys anywhere.** If you ever feel the urge to add an `ANTHROPIC_API_KEY` env var, stop — the design is sub-processes only.
- **Touch targets stay 44px+.** See [design.md](design.md).

## Workflow

- **Don't `npm run build` while `npm run dev` is running.** The build rewrites `.next/` under the live server, which then 500s on every route with `Cannot find module './NNN.js'` — an error that points at webpack internals rather than at what you did. Stop the preview first, or verify the build after you're done with the browser. (The `launch` skill / preview tooling makes this easy to trip over, because the dev server outlives the task that started it.)
- **A repo hook flags `.exec(` as `child_process.exec`.** It fires on `RegExp.prototype.exec` and better-sqlite3's `db.exec` too. Don't weaken the call to appease it — use `String.match()` for regexes and `db.prepare(sql).run()` for single statements, both of which are equivalent here and clearer anyway.


```bash
npm install            # one-time
npm run dev            # http://localhost:3000
npm run typecheck      # tsc --noEmit, must pass
npm test               # vitest run, must pass
npm run build          # production build, used by CI / before deploy
```

## Verifying changes

| Change kind | Run |
|---|---|
| DB schema / migration | `npm test` + confirm `ensure()` was added in `migrate()` |
| API route | `npm run typecheck` + `npm test` + exercise via curl/browser |
| Frontend (component/styles) | Resize preview to 375×812, then 1280×800 |
| Provider / dispatch logic | `npm test` + a `DRYDOCK_PROVIDER_STUB=1` dry run (`drydock-uat` skill) |
| Cap / queue / cancel | `npm test` (`dispatch-cap.test.ts`, `stream-route.test.ts`) — verify against a prod build, not `next dev` (see DD-009) |
| Dependency install/upgrade | Check `vibe-coding-security` advisories first, then `npm run build && npm test` |

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

## Escalate to a human when…

- A schema change cross-cuts DB + API + frontend — sketch the migration in a `docs/` file first.
- An Apple Notes sync scenario isn't covered by the conflict-resolution cheat sheet above.
- Loosening the `irreversible done` rule or the id-stable write path (both protected in CLAUDE.md).
- Changing an `autonomy` profile's Bash allowlist, or considering `--dangerously-skip-permissions` for any provider (banned).
- The user says "ship it" but `npm test`/`npm run typecheck` is still failing for unrelated-looking reasons.

## What lives outside this repo

- DB file: `~/.drydock/drydock.db`
- Per-task worktrees: `~/.drydock/worktrees/<projectId>/<taskId>/` (Phase 2; kept on success so the user can inspect/PR)
- Project discovery root: `~/Documents/Projects` by default. Override with `DRYDOCK_PROJECTS_ROOT` env var.
- Claude OAuth session: `~/.claude/`
- Claude Code session logs: `~/.claude/projects/<dash-encoded-cwd>/<sessionId>.jsonl` — read (numeric aggregation only, no content) by `lib/providers/claude-usage.ts` for the Settings → Provider budgets Claude card. Never write back.
- Codex CLI session logs: `~/.codex/sessions/**/*.jsonl` (rollouts nested under `YYYY/MM/DD/`) — read (`token_count` aggregation only, no content) by `lib/providers/codex-usage.ts` for the Codex card. Never write back.
- Gemini OAuth session: `~/.gemini/`
- Antigravity step logs: `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/*.{jsonl,txt}` — read (activity counts only: step type, timestamp, tool-call count; never message content) by `lib/providers/gemini-usage.ts` for the Google card. Never write back.
- Cloudflare Tunnel credentials JSON: `~/.cloudflared/<UUID>.json`

None of those should ever appear in `git diff`.
