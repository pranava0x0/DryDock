---
name: drydock-uat
description: >
  Lightweight UAT for the DryDock orchestrator (this repo). Use whenever the
  user asks to "UAT DryDock," "QA DryDock," "test the orchestrator UI,"
  "check DryDock for bugs," or "smoke-test the dashboard." Walks the
  Next.js app at localhost:3000 with the Claude_Preview MCP, exercises the
  UX flows without dispatching real Claude/Gemini agents, and audits
  perf + data efficiency (bundle weight, API call counts, payload sizes,
  redundant fetches). On first run, learns the project structure and
  writes uat.md. On subsequent runs, draws from uat.md + issues.md to
  run smarter, more targeted tests.
compatibility: >
  Requires the Claude_Preview MCP (preview_start, preview_snapshot,
  preview_click, preview_fill, preview_screenshot, preview_resize,
  preview_eval, preview_network, preview_logs, preview_console_logs,
  preview_stop) and Bash. Designed for the dev launch config
  drydock-dev (npm run dev) in .claude/launch.json.
---

# DryDock — Self-Improving UAT Skill

## What this skill does

Runs a focused UAT session on the DryDock orchestrator at this repo. Each run:
1. Loads the learned pathways log from `uat.md`
2. Executes all critical baseline flows (never skip these)
3. Audits **perf + data efficiency** (bundle weight, request count, payload size, redundant fetches)
4. Adds a small randomized exploration layer
5. Logs new bugs to `issues.md`, ideas to `drydock-backlog.md`
6. Appends newly-discovered paths to `uat.md` so future runs are smarter

## Operating principles

- **Never dispatch a real agent.** This skill is for UX + perf testing, not orchestrator stress testing. Real `POST /api/tasks/[id]/run` calls spawn `claude` / `gemini` subprocesses and consume the user's subscription. Use `preview_network` to assert the API was *callable*, but cancel before it shells out — see "How to test Run without spending tokens" below.
- **Touch the orchestrator lightly.** Create at most one ephemeral project + one ephemeral task per run. Delete both at the end. Never leave UAT data behind.
- **Read before write.** Always load `uat.md`, `issues.md`, `drydock-backlog.md` before doing anything — every run inherits prior knowledge.
- **Mobile first.** DryDock is a mobile-first PWA. Always run all three viewports (mobile 375×812, tablet 768×1024, desktop 1280×800) in that order.
- **Stay within scope.** Don't open the parent /Projects/ backlog or other project folders. UAT touches only DryDock files.

---

## Step 0: Load context

Read these four files before doing anything else:

```
Read: .claude/worktrees/<current>/uat.md             # baseline pathways (may not exist on first run)
Read: .claude/worktrees/<current>/issues.md          # known bugs — don't re-report
Read: .claude/worktrees/<current>/drydock-backlog.md # known feature gaps
Read: .claude/worktrees/<current>/design.md          # visual contract
```

Summarize: open issue count, last UAT run date, areas marked flaky, sections not recently tested.

---

## Step 1: Start the dev server

The launch config is **drydock-dev** in [.claude/launch.json](.claude/launch.json) (`npm run dev`, port 3000, autoPort on).

```
preview_start name: "drydock-dev"
```

Wait for `Ready in <Xms>` in `preview_logs`. Then take a screenshot and check `preview_logs level: error` for build errors.

⚠️ **Hydration gotcha:** dev-mode client components take ~1–2 s to hydrate after first render. If `preview_click` fires before hydration, the event lands on a DOM node with no React handler attached and silently does nothing. Confirm hydration before interacting:

```js
preview_eval: (() => { const fab = document.querySelector('button[aria-label="Add project"]'); return !!Object.keys(fab || {}).find(k => k.startsWith('__reactProps')); })()
```

Retry after ~1 s if it returns false.

---

## Step 2: Three-viewport baseline (mandatory every run)

Run desktop → tablet → mobile in that order. DryDock is **explicitly mobile-first** per [design.md](design.md), so the mobile pass is the most load-bearing — but all three must be clean before you log the run as green.

```
preview_resize width: 1280 height: 800   # desktop
preview_resize preset: "tablet"          # tablet
preview_resize preset: "mobile"          # mobile (canonical)
```

For each viewport, walk every baseline flow below. Note: an issue that appears on only one viewport usually points to a missing `sm:` / `md:` / `lg:` qualifier in the Tailwind classes — check the responsive contract in design.md.

### BF-01 · Dashboard loads cleanly
- Navigate to `/`
- Verify: `⚓ DryDock` header wordmark, project count visible, either empty-state with `🏗️` crane OR a list of ProjectCard
- Console clean: `preview_console_logs level: error` → no logs

### BF-02 · Create project flow
- Click the FAB (`button[aria-label="Add project"]`)
- AddProjectModal opens with: Name, Local path, Description, Quality gate (optional), Default provider (Claude/Gemini), Cancel/Create
- Fill in a **temporary** project: name = `UAT smoke ${Date.now()}`, path = `/tmp/uat-smoke`, leave test_command blank, provider = claude
- Submit. Verify card appears on the dashboard with `0 pending / 0 active / 0 done` counts
- Record the new project id for cleanup at the end

### BF-03 · Project detail loads
- Click into the new project
- Verify: back link (`← Back to projects`), name, path in mono, provider badge, "TASKS" section with `⚓` empty state

### BF-04 · Create task flow
- Click the FAB on the project page
- Modal opens with: Title, Description, Provider (defaults to project's), Cancel/Create
- Fill a temporary task: title = `UAT smoke task`, description = `do not run`, provider = claude
- Submit. Verify TaskCard appears with Pending badge + Run button + Delete button

### BF-05 · Run button + SSE failure surfacing (without spending tokens)
This is the highest-risk flow because it touches the dispatcher. To exercise it **without dispatching a real agent**, point the project at a path that doesn't exist on this machine so `claude` is invoked but the project dir spawn fails quickly:

- The project we created in BF-02 already uses `/tmp/uat-smoke` (a path that may or may not exist — fine either way).
- Click Run. The task transitions Pending → Failed within ~2 s as the spawned `claude` exits with ENOENT (no such file/binary on PATH) or the project dir is missing.
- Verify the StreamViewer opens with `[connected — waiting for output]`, then renders the stderr line + `[exit code -1]`.
- Verify the TaskCard status flips to Failed and the **Retry** button (amber) appears in place of Run.

**If `claude` IS on PATH on the host Mac**, click Run still won't spend tokens because `/tmp/uat-smoke` doesn't exist — the CLI itself will error out before sending anything.

### BF-06 · Retry flow
- Click Retry on the failed task. Status flips back to Pending, Run button reappears.
- Do NOT click Run a second time — we've already exercised the path.

### BF-07 · Delete cleanup (always at end of run)
- Delete the temporary task (Delete button → confirm)
- Navigate back to dashboard. Delete the temporary project via the API (DELETE `/api/projects/{id}`) since there's no UI affordance yet — this is a gap to log if it isn't already in the backlog.
- Verify dashboard returns to its pre-run state.

---

## Step 3: Perf + data-efficiency audit

DryDock is on the user's Mac with a Cloudflare Tunnel to a phone, so every wasted byte is felt twice. Run this every UAT.

### P-01 · Bundle weight
Run `npm run build` (NOT in the preview — just check the output). Capture per-route sizes:

```bash
npm run build 2>&1 | grep -E "First Load JS|First Load|Route \(app\)" -A 20
```

Baseline (post-Phase 3, recorded 2026-05-12):
- `/` → 2.68 kB route, 112 kB first load
- `/project/[id]` → 4.17 kB route, 113 kB first load
- API routes → 151 B each, 100 kB shared

**Flag a regression** if any client route's first-load grows by >20 kB without an obvious reason in the diff. Log it as `issues.md` entry with severity high.

### P-02 · Request count + payload size on dashboard
With the preview server running, open the dashboard and use `preview_network` to capture every request the page makes. Acceptable budget for a cold load of `/`:

- ≤ 1 `GET /api/projects` call
- ≤ 30 Next.js JS chunks total
- Total transfer < 200 KB compressed

**Flag** if any single `/api/projects` response is > 50 KB — the dashboard already attaches task_counts, so this should stay tight even with 100 projects.

### P-03 · Redundant fetches
Open the project detail page and `preview_network`. Verify:

- The page issues `GET /api/projects/{id}` AND `GET /api/tasks?projectId={id}` on mount — that's expected.
- Once the StreamViewer is open, the project detail page polls every 2 s (`refresh()` inside the `streamTaskId` effect). Confirm exactly 2 polled requests per cycle (one project, one tasks list). **If you see 3+, that's a regression** — it means a child component is also fetching.
- The `/api/tasks` payload includes `latest_run` per task. Don't follow up with per-task run fetches.

### P-04 · SSE backpressure
With a Failed task, click View output. The `/api/tasks/{id}/stream` endpoint should:
- Send one `event: open` + the replayed transcript + one `event` with type `exit`, then close (~3 messages total).
- NOT stay open indefinitely after `exit`.

Use `preview_network` filtered to "stream" to confirm the response Content-Length is bounded and the connection closes within 1 s of the exit event.

### P-05 · DB efficiency
Open a project page with multiple tasks. The `/api/tasks` response should include `latest_run` per task — verify this means the SQL did N+1 queries (one per task for `getLatestRunForTask`). With < 50 tasks per project this is fine; if a future change makes tasks lists much longer, log a backlog item to switch to a single windowed SQL query.

### P-06 · Image weight
The only image asset is [public/icon.svg](public/icon.svg). Confirm:
- Served as SVG (`Content-Type: image/svg+xml`)
- < 2 KB
- Not rasterized into multiple PNG variants

### P-07 · Memory footprint of the orchestrator hub
The in-memory event hub ([lib/orchestrator/hub.ts](lib/orchestrator/hub.ts)) keeps a history per run forever (until `release` is called, which today is never called). After several runs, this leaks. Flag any session where you've personally created > 20 runs without restarting the dev server — long-running sessions will hit this. Track in backlog if not already DD-BL-15 or similar.

---

## Step 4: Visual/UX checks per viewport

For each viewport, on the dashboard AND project page:

- [ ] Page background is Kraken Deep Sea Blue (`#001628`). Hex check via `preview_inspect`.
- [ ] Wordmark shows `⚓ DryDock` in the header.
- [ ] FAB is Kraken Ice on Deep, ≥ 44×44px, sits above iOS safe-area inset on mobile.
- [ ] Every interactive element ≥ 44×44px. Spot-check Run / Retry / Delete on a TaskCard.
- [ ] No horizontal scroll on mobile. `document.documentElement.scrollWidth === document.documentElement.clientWidth`.
- [ ] Provider badges: violet for Claude, blue for Gemini. Never both for one task.
- [ ] Failed status badge uses kraken-alert red (`#E9072B`), not Tailwind red-300.
- [ ] Focus ring on form inputs is Kraken Ice on tab navigation.

---

## Step 5: Randomized exploration

Pick ONE of these per run (rotate over time, log which one in `uat.md`):

- Hammer the AddProjectModal: open, type 100 chars in the name, paste an unusual path (`/path with spaces/repo`), submit. Verify graceful behavior.
- Stream a fast-failing task and abruptly resize the viewport from mobile to desktop. The StreamViewer should re-anchor without losing the transcript.
- Click Retry → Run → Retry → Run in quick succession on the same task. The atomic claim (`claimTask`) should keep dispatcher state consistent; the 2nd Run shouldn't double-dispatch.
- With > 5 tasks on a project, scroll the task list. The page should not re-fetch on scroll.

---

## Step 6: Log findings

### Issues format ([issues.md](issues.md))

```markdown
| ID | Date | Area | Description | Severity | Size | Cause | Status |
|---|---|---|---|---|---|---|---|
| DD-NNN | YYYY-MM-DD | dashboard | Description ≤ 80 chars | critical/high/medium/low | S/M/L | code bug/test bug | Open/Fixed |
```

Don't re-log a bug that's already Open. If you find a regression of a previously-Resolved issue, move it back to Active with a note.

### Backlog format ([drydock-backlog.md](drydock-backlog.md))

```markdown
| DD-BL-NN | One-line feature | priority | complexity | size | impact | Not Started/In Progress/Shipped |
```

### `uat.md` (this skill creates + updates it)

Append discovered pathways, selectors that worked, and timing notes so future runs are faster.

---

## Step 7: Cleanup + report

- Delete any UAT-created projects/tasks left in the DB.
- Stop the preview: `preview_stop serverId: <id>`.
- Print a one-line summary: `UAT pass: <N> baseline flows green, <K> issues logged, <P> perf regressions, <V> visual issues. Duration ~<X> min.`

---

## How to test "Run" without spending tokens

Three lines of defense, in order:

1. **Project path that doesn't exist** — Best. The `claude` / `gemini` CLI fails before contacting the model. We use `/tmp/uat-smoke` which we don't create.
2. **`claude` / `gemini` not on PATH** — Backup. The dispatcher catches the ENOENT and emits a clean stderr + exit.
3. **Provider stub via env var** — Not yet wired. If you ever need to force a stub provider in dev, add a `DRYDOCK_PROVIDER_STUB=1` env var path in [lib/providers/index.ts](lib/providers/index.ts) and document it here. This is a backlog item.

**Never** point the UAT project at a real local repo and click Run. That's a real dispatch.

---

## What success looks like

A clean UAT run completes in 4–6 minutes and prints:

```
UAT pass: 7 baseline flows green, 0 new issues, 0 perf regressions, 0 visual issues.
Bundles: / 112kB, /project/[id] 113kB (unchanged).
Requests: dashboard 1×/api/projects, project page 2×/api + 0 redundancy.
SSE: open + replay + exit, connection closed within 1 s.
Duration: 4 min 32 s.
```

A failed UAT run logs every new issue to `issues.md` with severity + size, and posts a one-paragraph summary at the top of the session output.
