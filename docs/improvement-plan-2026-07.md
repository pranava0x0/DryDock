# DryDock Improvement Plan & Spec — July 2026

> **Status (2026-07-12):** **EP-1 (Lock the front door)** and **EP-2 (Tasks become resumable threads)** shipped in PR #7 — auth middleware + loopback bind, autonomy profiles, concurrency cap/queue/drain + restart reconciliation, cancel, session capture, follow-up turns via `claude --resume`, retry-with-feedback, and the thread UI. Seven Codex/self-review findings were fixed in the same PR (DD-011…DD-015). **EP-3+ (close the git loop: diff view → commit → push → PR/merge) is the next epic and remains unstarted.** The sequencing and specs below are unchanged from the original plan.

Research-grounded plan for the next generation of DryDock. Sources: full codebase inventory (this repo, July 2026), OpenAI Codex product evolution (Sept 2025 – July 2026), Google Antigravity 1.0 → 2.0 (Nov 2025 – June 2026), Claude Code ecosystem (mid-2026), and a mining pass over pranava0x0's own GitHub review history (April – July 2026) for the practices this plan should bake in rather than fight.

---

## 1. Executive summary

DryDock's core bet — **dispatch agents into per-task git worktrees, watch from a phone** — was validated hard: the Codex app (Feb 2026) and Antigravity's Agent Manager converged on exactly this shape. The bad news is the baseline moved. In mid-2026, an orchestrator that can't show a diff, take a follow-up turn, or open a PR reads as a log viewer, not a control surface.

Three structural gaps dominate everything else:

1. **Fire-and-forget only.** `stdin` is ignored at spawn (`lib/providers/spawn.ts`), every run is a fresh one-shot `--print`. No follow-up, no steer, no resume. Every peer product treats a task as a persistent thread now.
2. **The loop never closes.** No diff view, no commit, no push, no PR, no merge — `tasks.pr_url` exists in the schema but nothing writes it. Reviewing an agent's work means leaving the app for a terminal.
3. **The front door is open.** The Cloudflare Tunnel URL has zero auth (no middleware, no session, nothing). Anyone with the URL can execute code on the Mac. This was already P1 (DD-BL-07); it is now a blocker for every other phone-facing feature in this plan.

The plan: **secure the door, make tasks threads, close the git loop** — then layer on the triage UX, notifications, verification evidence, and provider refresh that turn DryDock into a genuine mission control. DryDock's phone-first PWA remains a real differentiator (Antigravity still has no first-party mobile; Conductor/Claude Squad/Sculptor are desktop-bound) — but only once review-and-merge works from the couch.

One process finding, separate from the app itself: **DryDock is the only active repo not following its owner's own ritual.** The entire May 24 feature wave landed as direct-to-main commits without PRs (only PRs #1–#4 ever existed, none received review), and the repo has never had a Codex bot review — while every other active repo (FirstPassRx, bubblebook, shirtpost, …) runs PR + `@codex review` + multi-lens self-review with per-finding disposition. Fix the process alongside the product.

---

## 2. Where DryDock stands (July 2026 snapshot)

**Works well (don't touch, or polish only):**
- Worktree-per-task isolation with graceful non-git fallback (`lib/orchestrator/worktree.ts`) — fully commodity now, and DryDock's version is solid.
- Atomic task claim (compare-and-swap), single synthesized `exit` event, DB replay for terminal runs — hard-won invariants (DD-001…DD-003), keep them.
- Cost capture from `stream-json`, monthly budget rollup, 5h-session budget pill, provider usage cards reading local session logs for Claude / Codex / Antigravity — ahead of most peers.
- Apple Notes backlog sync — battle-hardened (DD-004…DD-008), unique, leave it alone.
- Policy model routing engine + analytics page (DD-BL-32/33) — shipped, though the routing UI is currently hidden (DD-BL-35).
- 23 test files / 252 cases over `lib/` with a regression-test-per-bug culture.

**Gap map (from the capability inventory):**

| Gap | Severity | Detail |
|---|---|---|
| No auth on tunnel | **P0 — security** | No `middleware.ts`, no token, no Access policy. Remote RCE surface. |
| No follow-up / resume / multi-turn | **P0 — product** | `stdio: ["ignore",…]`; no session id captured; Retry is a clean restart. |
| No diff / commit / push / PR / merge | **P0 — product** | `pr_url` schema stub; `worktree.ts:146` comment is aspirational. Transcript text is the only review surface. |
| No cancel button | P1 | Running subprocess only dies on SSE disconnect or the 10-min timeout. |
| No concurrency cap / queue | P1 | N Run clicks = N unbounded subprocesses. |
| No permission-mode decision for `claude` | P1 | No `--permission-mode`/allowlist flags passed; behavior implicitly depends on host `~/.claude/settings.json`. Implicit ≠ safe. |
| Gemini provider facing sunset | P1 | Consumer Gemini CLI stopped serving June 18, 2026 (replaced by Antigravity CLI). `gemini -p` is a dead end. |
| No Codex dispatch provider | P2 | User demonstrably uses Codex daily (reviews on every repo, local usage already read) but DryDock can't dispatch to it. |
| Raw text stream, no structured events | P2 | DD-BL-08: parser flattens to text; tool calls invisible. |
| No completion artifact | P2 | No walkthrough/summary; user re-reads the whole transcript. |
| Notifications only while tab open | P2 | Notification API only; DD-BL-15/28 unshipped. |
| Routing rules UI hidden | P2 | Engine + API live; UI removed pending dry-run mode (DD-BL-35). |
| Untested: `app/` layer, db accessors, provider argv | P2 | Route handlers, analytics math, `claude.ts`/`gemini.ts` argv construction have no tests. |
| 10-min timeout | P3 | Modern agent runs routinely exceed this; peers run multi-hour. |
| Gemini model routing silently ignored | P3 | `model` option dropped by gemini provider — a confident-looking no-op. |

---

## 3. How the world changed (and what it means here)

Condensed from the research sweeps; dates are ship dates.

**Codex (OpenAI).** Codex app (Feb 2026): parallel agent threads × built-in worktrees × diff review with inline comments and selective commit × Skills library × scheduled automations feeding a review queue. Mobile (May 14, 2026): phone as full remote control — live diffs/terminal/screenshots, approval prompts as actionable cards, host switching; Codex Remote GA June 25 with QR pairing. Git loop closed since 2025: auto-PR from tasks, `@codex review` on every PR (P0/P1-only findings, AGENTS.md-driven), "@codex fix" spawns a task pushing to the branch. CLI: `codex exec --json` headless, `codex exec resume <thread>`, subagents as TOML with per-agent model/effort/sandbox (`max_threads` default 6), permission *profiles* replacing binary full-auto (Apr 2026), hooks GA (May 2026), thread handoff between hosts (July 8, 2026).

**Antigravity (Google).** Agent Manager as the product (2.0, May 19, 2026): standalone app + CLI + SDK; agents emit **Artifacts** — task lists, implementation plans, diffs, screenshots, browser recordings, and **Walkthroughs** (what changed + how to test) — with Google-Docs-style comments the agent consumes mid-run *without restarting*. Browser-based self-verification with recorded video. Knowledge base distilling reusable learnings from completed tasks. Scheduled tasks. **Gemini CLI sunset June 18, 2026** for consumer tiers — Antigravity CLI (Go) is the successor. No first-party mobile as of July 2026.

**Claude Code.** Background-by-default subagents (July 2026), workflows fanning out hundreds of agents, `claude agents` view grouped **Needs input / Working / Completed**, background agents **auto-commit + push + draft-PR** when finishing worktree work (June 29, 2026), `/rc` remote-control QR + `--teleport` bidirectional session handoff, hooks as the notification control plane (`agent_needs_input` / `agent_completed`), first-class sandboxing.

**Table stakes in mid-2026** (every serious orchestrator): triage-grouped mission control; worktree isolation; follow-up-without-restart; in-app diff review as the merge gate; auto-commit→push→draft-PR; plan-then-execute gate; structured completion artifact; notifications routed to the human; per-task model choice + cost meters; parallel agents with a concurrency cap; scheduled agents.

**Still differentiating** (worth owning): verification *evidence* (screenshots/recordings/verdicts, not just green tests); comment-on-artifact steering; knowledge base that actually works; best-of-N with comparative diff review; bidirectional phone↔terminal handoff; **polished first-party mobile control — DryDock's lane**.

---

## 4. Jobs to be done & E2E scenarios

The user is a solo builder with ~12 active repos, three agent subscriptions (Claude Max, ChatGPT Plus/Codex, Google AI Pro/Antigravity), a Mac that stays on, and a phone. DryDock's job is not "run agents" — the CLIs do that. DryDock's job is **command and control while away from the desk, and fleet economics while at it**.

**JTBD-1 — Dispatch from anywhere.** *When an idea or bug hits while I'm away, I want to fire an agent at the right project in under 30 seconds, so the work is done or reviewable by the time I'm back.*
Today: works (backlog burn-down / add task → Run). Friction: no auth means the URL can't be shared or bookmarked safely; no templates; provider choice is manual.

**JTBD-2 — Triage at a glance.** *When I open DryDock, I want to see what needs ME — not a project grid — so I spend attention only where the fleet is blocked or finished.*
Today: dashboard is project-first; RunningTasksPanel shows in-flight only; "done awaiting review" isn't a concept.

**JTBD-3 — Judge and ship from the phone.** *When an agent finishes, I want to see what actually changed (diff + walkthrough + gate verdict + cost) and ship it or reject it in under a minute, without opening a laptop.*
Today: impossible. The only evidence is a text transcript; shipping requires a terminal.

**JTBD-4 — Steer without restarting.** *When the agent got it 80% right, I want to say "now also fix the tests" and have it continue with full context, not start over.*
Today: impossible (one-shot spawns, no session capture).

**JTBD-5 — Stay safe and solvent.** *I want hard limits — auth, permission boundaries, concurrency caps, budget alerts — so an open URL, a runaway agent, or a $40 day can't happen silently.*
Today: budget alerts exist (tab-open only); auth and caps don't.

**JTBD-6 — Let the fleet work the backlog.** *I want recurring/scheduled work (nightly dep audit, CI-failure fixes) to flow into a morning review queue without me dispatching anything.*
Today: nothing scheduled; CI failures invisible (DD-BL-31 unstarted).

### E2E scenarios (acceptance narratives)

**S1 — The couch loop (golden path).** 9pm, phone. Open DryDock → "Needs review (2)" at top → tap task → Walkthrough card ("Added rate-limit middleware; 3 files; run `npm test` to verify — passed in gate") → tap Diff → skim 3 files → tap **Create PR** → Codex bot reviews it on GitHub → next morning, laptop: merge. *Breaks today at: review (no diff), ship (no PR).*
**S2 — The steer.** Agent's change breaks a type. Task card shows gate ❌ with the tsc output. Type "fix the type errors in the gate output" → **Follow up** → same session resumes in the same worktree, gate re-runs, goes green. *Breaks today at: everything after "shows gate ❌".*
**S3 — The morning queue.** Nightly scheduled task "audit deps & update lockfile-safe minors" ran at 3am on 2 projects; both sit in Needs review with diffs + passing gates. One tap each → PRs. *Doesn't exist today.*
**S4 — The runaway.** Agent loops on a flaky test at $0.60/min. Push notification at 80% session budget → open task → **Stop** → transcript + partial diff preserved for inspection. *Today: no push when tab closed, no stop button.*
**S5 — The stranger.** Someone finds the tunnel URL. They get a Cloudflare Access login wall tied to pranava.raparla@gmail.com, and nothing else. *Today: they get a working orchestrator.*

---

## 5. The plan

Nine epics, ordered by dependency and leverage. Sizes: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks of focused solo work.

| # | Epic | Size | Priority | Depends on | Absorbs backlog items |
|---|---|---|---|---|---|
| EP-1 | Lock the front door (auth + permission profiles + caps + cancel) | M | **P0** | — | DD-BL-07 |
| EP-2 | Tasks become threads (session capture, follow-up, steer) | M | **P0** | EP-1 for phone use | — |
| EP-3 | Close the git loop (auto-commit, diff API/viewer, push, PR, merge) | L | **P0** | EP-1 | DD-BL-10, DD-BL-12 |
| EP-4 | Mission-control triage UX + structured events + walkthrough artifact | M | P1 | EP-2/3 enrich it | DD-BL-08 |
| EP-5 | Notifications that reach the phone (webhook + Web Push) | M | P1 | EP-1 | DD-BL-15, DD-BL-28, DD-BL-20 (partial) |
| EP-6 | Provider refresh (Codex provider, Antigravity migration, routing UI unhide, timeouts) | M–L | P1 | — | DD-BL-35, DD-BL-19 (partial) |
| EP-7 | Verification verdicts (janitor review + evidence hooks) | M | P2 | EP-3 (diff) | DD-BL-30 |
| EP-8 | Scheduled dispatch + CI-failure intake | M | P2 | EP-1, EP-5 | DD-BL-31 |
| EP-9 | Test/process hardening (app-layer tests, PR ritual, supply chain) | M | P1 (ongoing) | — | — |

Deliberately **deferred** (revisit after EP-1…5 land): DD-BL-25 dependency graph, DD-BL-26 LLM decomposer, DD-BL-27 swarm / best-of-N, DD-BL-29 memory store, DD-BL-34 MCP server, DD-BL-06 Turso. Rationale in §7.

Suggested sequencing: EP-1 → EP-2 → EP-3 (the spine, ~3–4 weeks) → EP-4 + EP-5 (the payoff, ~1.5 weeks) → EP-6 → EP-7/8 as appetite allows. EP-9 runs alongside everything.

---

## 6. Detailed specs

Conventions for all epics, sourced from this repo's own agreements and the owner's review history:
- Schema changes go in `lib/db/schema.sql` **and** an `ensure(...)` call in `migrate()` (`lib/db/index.ts`) — existing DBs must upgrade in place.
- All mutations through `lib/db/*.ts`; no raw SQL in route handlers; new routes export `runtime = "nodejs"`.
- **Invariants live in the DB or server, never only the UI** (shirtpost PR #1 lesson: partial unique indexes / CAS updates, buttons merely disable).
- **Fail loudly**: no success chip unless the underlying check actually passed; errors surface as structured state, never empty-render (the `RunningTasksPanel` silent-error fix is the local precedent).
- **Never render a confident wrong value**: unknown states say "unknown", not a plausible default (FirstPassRx lesson).
- **Bounded I/O everywhere**: every outbound call gets a timeout below its route deadline; retries use backoff.
- **One regression test per bug, verified to fail without the fix.** New features get happy-path + failure-path tests in `lib/**/*.test.ts`.
- Mobile-first: verify at 375×812; touch targets ≥ 44px; loading/error/empty states on every new view.
- No API keys, ever. Subprocess OAuth only.

---

### EP-1 — Lock the front door

**Problem.** The tunnel URL is an unauthenticated remote-code-execution endpoint. Separately, `claude` is spawned with no explicit permission flags — whatever `~/.claude/settings.json` happens to allow is what agents can do, which is invisible and unversioned. And N concurrent Run taps spawn N unbounded subprocesses with no way to stop any of them.

**1a. Cloudflare Access + middleware verification.**
- Configure a Cloudflare Access application over the tunnel hostname; policy: One-Time PIN to `pranava.raparla@gmail.com` (no new secrets, consistent with the no-API-key philosophy). Document in `docs/setup.md` §5.
- Add `middleware.ts`: verify the `Cf-Access-Jwt-Assertion` JWT against the team's public JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), checking `aud` == `CF_ACCESS_AUD`. Cache JWKS in-process (re-fetch on kid miss; 10s fetch timeout). Env: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
- **Bypass rule:** requests from localhost (dev, and the Mac itself) skip verification — keyed on the absence of CF headers *plus* host being `localhost:3000`/`127.0.0.1`; never trust a spoofable header alone.
- Fallback for non-Cloudflare setups: `DRYDOCK_AUTH_TOKEN` env; when set, middleware accepts `Authorization: Bearer <token>` (PWA stores it once via a settings prompt). Access and token modes are mutually exclusive; if neither is configured and the request is non-local, **deny with a setup hint** — fail closed, not open.
- PWA note: Access session cookie duration set to ≥ 30 days so the home-screen app doesn't re-prompt constantly.

**1b. Explicit autonomy profiles per project.**
- New `projects.autonomy` column (`TEXT DEFAULT 'edits'`): `readonly` | `edits` | `full`.
  - `readonly` → `--permission-mode plan` (analysis/planning tasks; no writes).
  - `edits` (default) → `--permission-mode acceptEdits` + `--allowedTools` curated list (Edit/Write/Read/Glob/Grep + `Bash(npm test:*)`, `Bash(npm run typecheck:*)`, `Bash(git status:*)`, `Bash(git diff:*)`).
  - `full` → `acceptEdits` + broader Bash allowlist (still **never** `--dangerously-skip-permissions` — per `vibe-coding-security/prevention`: not on the host, ever).
- Thread through `lib/providers/types.ts` → `claude.ts` argv. Gemini/Codex equivalents mapped per-provider in EP-6 (Codex: permission profiles; Antigravity: its unified permissions).
- Surface as a small selector on the project page + in AddProjectModal. Show the active profile on TaskCard so a run's blast radius is legible.
- Test: argv-construction unit tests per profile (this also starts covering `claude.ts`, currently untested).

**1c. Concurrency cap + queue.**
- Setting `max_concurrent_runs` (number, default 3; allow-listed in `/api/settings` — extend the allow-list beyond boolean to typed values).
- New task status `queued` between `pending` and `claimed`. `POST /run` when at cap: claim CAS moves `pending → queued` (still atomic) and returns 202 `{queued: true, position}` instead of dispatching. Dispatcher finalization (the same place the synthesized `exit` fires) pops the oldest `queued` task and dispatches it.
- Invariant in DB: the cap check re-counts `status IN ('claimed','running')` inside the same transaction as the claim — UI disabling the button is cosmetic only.
- UI: queued tasks show "⏳ queued (#2)" on TaskCard and in RunningTasksPanel.
- Tests: cap honored under parallel dispatch (concurrency test, same spirit as `test_inflight_unique_index_blocks_second_pending`), queue drains FIFO, queue survives restart (queued is a DB status, not memory).

**1d. Cancel.**
- `POST /api/tasks/[id]/cancel`: looks up the active run controller (`getActiveRunController`), aborts it (SIGTERM→SIGKILL path already exists), marks run `failed` with `failure_reason='cancelled'`, task `failed`. Idempotent: cancelling a terminal run returns 200 `{alreadyTerminal: true}`.
- UI: ⏹ Stop on TaskCard + StreamViewer while `running`. Partial output/diff remain inspectable (worktree kept, same as failure path today).
- Decouple abort from SSE disconnect: **stop killing the subprocess on stream disconnect** (`stream/route.ts:47-52`). Phone users lose connections constantly; a dropped SSE must not kill a healthy run. The subprocess should die only on cancel, timeout, or completion. This is a behavior change — note it in AGENTS.md.
- Tests: cancel mid-run persists partial output; cancel is idempotent; SSE disconnect no longer aborts (regression-pin the old behavior's absence).

**Out of scope:** multi-user auth/roles (single-human product); rate limiting (Access absorbs it).

---

### EP-2 — Tasks become threads

**Problem.** Fire-and-forget made sense in Phase 1; in mid-2026 every peer treats a task as a persistent, steerable thread. The enabler is cheap: Claude's `stream-json` already includes `session_id` on its events, and `claude -p --resume <session-id> "<prompt>"` continues a session headlessly with full context.

**2a. Session capture.**
- `runs.session_id TEXT` (schema + `ensure`). Parser: `claude-parse.ts` already handles the `result` event — extract `session_id` from it (also present on the `init` system event; take whichever arrives first). Persist onto the run row at finalization.
- Codex equivalent (EP-6): thread id from `codex exec --json`; same column.

**2b. Follow-up turns.**
- `POST /api/tasks/[id]/followup` `{prompt}`. Preconditions: task terminal (`done`|`failed`), latest run has `session_id`, worktree still exists (if auto-cleaned, recreate from the task's branch — branch always survives cleanup). Creates a **new run row** on the same task (`runs.parent_run_id TEXT` for the chain), dispatches `claude -p --resume <session_id> --output-format stream-json --verbose [--model …] <prompt>` with cwd = the same worktree, then the normal gate → finalize → cleanup pipeline. Task status returns to `running` for the duration.
- Follow-up honors the same autonomy profile and routing rules? **No routing re-match** — a follow-up stays on the provider/model of its parent run (steering shouldn't silently switch models). Persist `matched_rule = 'followup:<parent>'`.
- UI: on a terminal task's detail/StreamViewer, a message box + **Follow up** button (the single highest-leverage UI element in this plan). Run history renders as a thread: run 1, follow-up 2, … each with its own gate verdict/cost; costs sum on the TaskCard strip.
- Failure honesty: if the CLI can't resume (session evicted/too old), surface a structured error chip "session expired — Retry starts fresh" rather than silently starting a new session (never render a confident wrong value: a fresh run masquerading as a continuation is exactly that).

**2c. Retry with feedback (small sibling).**
- Extend Retry to accept optional feedback text. With `session_id` present → follow-up under the hood; without → fresh run with the feedback appended to the prompt (`buildAgentPrompt` gains an optional `feedback` section). Keeps the existing one-tap Retry intact.

**Explicitly deferred to a later phase:** *mid-run* interactivity (answering permission prompts / injecting guidance while the process is live, Codex-approval-card style). That requires switching spawn to a persistent `--input-format stream-json` bidirectional process — a different lifecycle with its own failure modes. Ship post-run follow-ups first; they cover ~80% of the steering JTBD. Revisit as "EP-2v2" once EP-1…5 are stable.

**Tests:** session id parse (fixture stream) · followup argv includes `--resume` · followup on cleaned worktree recreates from branch · chain renders in replay · resume-failure surfaces structured error · costs aggregate across a chain.

---

### EP-3 — Close the git loop

**Problem.** The moment a run finishes, DryDock goes blind: the work sits as an unstaged/uncommitted pile in a worktree, invisible to the UI, unmergeable without a terminal. Meanwhile auto-commit → push → draft PR is now *native default behavior* in Claude Code's own background agents. The `pr_url` column has been waiting since Phase 2.

**3a. Auto-commit at finalization.**
- After agent exit 0, before the gate: if the worktree is dirty (`git status --porcelain`), `git add -A && git commit -m "drydock: <task title>" -m "Task <id> · <provider> · run <runId>"`. If the agent already committed (common for Claude), skip silently. Record `runs.commit_sha`.
- The gate then tests **committed** state — what you'd merge is what was tested (provenance principle: the artifact reviewed = the artifact recorded).
- Non-git projects: skip, as today.

**3b. Diff API + storage.**
- `GET /api/tasks/[id]/diff` → computed live from git (not stored — the branch is the source of truth; storing invites drift): merge-base diff `git diff <base>...<branch>` where base = the branch-point recorded at worktree creation (`tasks.base_sha TEXT`, new column, stamped in `worktree.ts`).
  - Response: `{ files: [{path, status(A|M|D|R), additions, deletions, patch}], totals, truncated }`. Compute via `--numstat` + per-file `git diff -- <path>`. Cap: patches > 400 lines/file return stats + first 400 lines + `truncated: true`; binary files stats-only. 10s exec timeout, structured 500 on failure.
  - Works after worktree cleanup too (branch survives; run diff from the project repo against the branch ref).
- **3c. Mobile diff viewer.** New `DiffViewer` component (bottom sheet, like StreamViewer): file list with `+n −m` chips → tap to expand unified hunks (monospace, horizontal scroll, ice/red-alert for +/− per design.md). Entry points: TaskCard "View diff" (any terminal task with a branch) and inside StreamViewer after exit. Loading/error/empty states mandatory; empty = "Agent made no file changes" (an honest and useful signal, not a blank).

**3d. Push + draft PR.**
- `POST /api/tasks/[id]/pr`. Preconditions: commit exists, project repo has an `origin` remote, `gh` CLI authenticated (detect once via `gh auth status`, cache 10 min). Steps: `git push -u origin <branch>` → `gh pr create --draft --title "<task title>" --body <generated>` → persist `tasks.pr_url` (finally writing the column) → return URL.
  - PR body: task description, run chain summary, gate verdict + tail of gate output, cost, and "🤖 dispatched via DryDock". This is the provenance record.
  - Per-project setting `auto_pr` (boolean, default off): when on, finalization runs 3d automatically after gate-pass (this is DD-BL-12; matches Claude Code's June 2026 default).
- **Codex-review handshake:** the user's standing reviewer is the Codex GitHub bot. Config field `projects.pr_review_hint`: when set to `codex`, PR creation posts an `@codex review` comment so review starts before the phone locks. (Cheap; rides the existing ritual.)
- Failure honesty: no remote / no `gh` auth → button renders disabled with the reason ("no origin remote"), not hidden and not failing on tap.

**3e. Merge (guarded).**
- Two paths, both explicit:
  - **PR merge:** `POST /api/tasks/[id]/merge` → `gh pr merge <url> --squash --delete-branch`. Guard: PR checks green (query via `gh pr checks`), gate passed. This is the phone-friendly path.
  - **Local merge** (repos with no remote): `git merge --squash <branch>` executed in the project dir **only if** the project working tree is clean (`git status --porcelain` empty) — never stomp uncommitted human work. Leaves the squash staged+committed with the same message as 3a.
- Both require an explicit confirm tap with the diff stat shown ("Merge 3 files, +120 −14 into main?"). DD-BL-10's "auto-merge on gate pass" is deliberately **not** implemented — the 2026 consensus kept a human diff-review gate even as auto-PR became default; auto-merge remains a future per-project opt-in once verdicts (EP-7) build trust.
- Record outcome on the task: `merged_at`, `merge_mode`.

**Schema:** `tasks.base_sha`, `tasks.merged_at`, `tasks.merge_mode`; `runs.commit_sha`; (uses existing `tasks.pr_url`). All with `ensure()`.
**Tests:** auto-commit skips when agent committed · base_sha diff correct after multiple commits · diff truncation · PR body content (pure builder function) · local merge refuses dirty project tree (regression test that must fail without the guard) · merge guard blocks on failing checks · pr_url persisted.

---

### EP-4 — Mission control: triage UX, structured events, walkthrough artifact

**Problem.** The dashboard answers "what projects exist", not "what needs me". Transcripts are undifferentiated text walls. Nothing summarizes what a run did.

**4a. Triage-first dashboard.**
- Reorganize `app/page.tsx` top-to-bottom into the `claude agents` / Codex-app grouping: **Needs attention** (failed · gate-failed · janitor-flagged · queued-too-long · *done-with-unmerged-diff*) → **Working** (running/claimed/queued, absorbing RunningTasksPanel) → **Recently shipped** (merged/PR'd, last 7 days) → project grid (collapsed by default on mobile).
- "Needs attention" derivation is a pure `lib/` function with tests — the categories are product logic, not view logic.
- Each card: one primary action (Review diff / Follow up / Stop / Run next) — one-tap triage, JTBD-2.

**4b. Structured events in the stream (DD-BL-08, properly).**
- Extend `claude-parse.ts`: emit `tool` AgentEvents from `assistant` events' `tool_use` blocks — `{name, target}` where target is the most human-salient input field (file_path for Edit/Write/Read, command for Bash, pattern for Grep/Glob; else omitted).
- StreamViewer renders tool chips inline ("✏️ lib/db/tasks.ts", "🔧 npm test") between text spans; RunningTasksPanel shows the latest chip as a live "now doing" line.
- Persistence: append compact one-liners into the existing output text for replay (`[tool] ✏️ lib/db/tasks.ts`) — no new table; replay fidelity without volume risk. `runs.tool_counts` JSON (`{"Edit":5,"Bash":3}`) for the analytics page later.
- Gemini/Antigravity: raw text stays as-is until EP-6 lands structured output.

**4c. Walkthrough artifact.**
- `buildAgentPrompt` appends a standing instruction: *"End with a `## Walkthrough` section: what changed (bulleted, by file), how to verify, anything left undone."* Parse the final `result` event's `result` text; extract from the `## Walkthrough` marker; store `runs.walkthrough TEXT`.
- TaskCard: walkthrough renders as the collapsed-by-default summary — **the first thing a phone user sees**, above the transcript (this is Antigravity's highest-praised pattern; also Devin's session summary, Factory's mission report).
- Honesty rule: if the agent didn't emit the section, show "no walkthrough provided" — don't synthesize one from the transcript and pass it off as the agent's.

**Tests:** tool-event extraction across fixture streams (incl. malformed blocks) · needs-attention bucketing · walkthrough extraction (present/absent/mid-text) · replay includes tool lines.

---

### EP-5 — Notifications that reach the phone

**Problem.** Every completion signal today requires the tab to be open. The entire async model depends on the phone buzzing.

**5a. Webhook notify (DD-BL-28) — ship first, it's an afternoon.**
- Settings: `notify_webhook_url` (string). On run finalization (done/failed/cancelled) and on budget threshold crossings: `POST {event, task_id, task_title, project, status, gate_status, cost_usd, branch, pr_url, walkthrough_first_line}`. 5s timeout, one retry after 10s, failures logged to console + a `last_notify_error` setting surfaced in Settings (fail loud, but never block finalization).
- Works with Slack incoming webhooks, Discord, **ntfy.sh** (zero-setup push app — likely the fastest path to real phone buzzes).
**5b. Web Push (DD-BL-15).**
- `web-push` dependency (install per supply-chain rules: check `vibe-coding-security` advisories, `npm ci --ignore-scripts`, exact pin). Generate VAPID keys once at boot if absent → `settings`. Service worker `public/sw.js` (extend PWA manifest wiring); subscription flow from Settings; subscriptions in new `push_subscriptions` table (endpoint PK, keys, created_at, last_ok_at). Push on: completed, failed, needs-input (future EP-2v2), budget thresholds. Dead subscriptions (410) pruned on send.
- Notification taps deep-link to the task (`/project/<id>?task=<id>` — requires EP-1 auth cookie to survive, hence the dependency).
**5c. Weekly digest (DD-BL-20, reduced scope):** reuse 5a — a scheduled job (EP-8 scheduler) POSTs a weekly cost/activity summary to the same webhook. No email service, no new deps.

**Tests:** payload builder (pure) · retry-once semantics (fake fetch) · finalization never throws on notify failure (regression) · 410 pruning.

---

### EP-6 — Provider refresh

**Problem.** The provider layer reflects early 2026: Gemini CLI is sunset for the user's tier (June 18, 2026), Codex — the user's most-used external agent — isn't dispatchable, model routing exists but is dark, Gemini silently ignores model routing, and the 10-minute timeout predates the era of long-running agents.

**6a. Codex provider.**
- `lib/providers/codex.ts`: `codex exec --json <prompt>` (headless JSONL, same line-buffered spawn wrapper). Parser `codex-parse.ts` mirroring claude-parse: flatten agent text, extract thread id (→ `runs.session_id`), token/cost from usage events where available. Resume: `codex exec resume <thread_id> <prompt>` → plugs straight into EP-2's follow-up.
- Permission mapping (EP-1b): autonomy profile → Codex sandbox/approval profile flags (read-only / write-restricted; exact flags verified against the installed CLI version at implementation time — pin what's tested into AGENTS.md).
- Register in `lib/providers/index.ts`, add to `ProviderName` union, AddTaskModal, routing-rule provider options. Update `budget-links` invariant tests (3 → still 3 cards, but the Codex card gains "dispatchable ✓").
- **Preflight check** shared by all providers: `GET /api/providers/health` runs `<cli> --version` + auth probe (10s timeout, 10-min cache) → Settings shows per-provider "ready / not authenticated / not installed" chips; dispatch to an unhealthy provider fails fast with that reason instead of a cryptic ENOENT (today's `claude: command not found` failure mode from setup.md troubleshooting).
**6b. Gemini → Antigravity migration.**
- Reality check via preflight: if `gemini -p` still functions on the host tier, keep it as legacy-deprecated (badge in UI). Add `lib/providers/antigravity.ts` targeting the Antigravity CLI's headless mode; **discovery task first** — flags for non-interactive dispatch, JSON output, session resume, permission mapping are TBD against the installed CLI (research confirms the CLI exists and inherits Gemini CLI's skills/hooks; exact scripting surface is uncertain). Time-boxed spike (½ day): if headless dispatch isn't viable yet, keep the provider stubbed behind preflight "not supported" and note it — an honest gap beats a broken provider.
- Fix the silent no-op meanwhile: gemini provider **rejects** a `model` option with a structured note in the stream ("model routing not supported for gemini") instead of dropping it.
**6c. Routing rules UI unhide (DD-BL-35).**
- Ship the blockers named in the backlog: `POST /api/routing-rules/dry-run` `{pattern, patternType}` → matches against the last 50 task prompts (title + description exactly as `buildAgentPrompt` sees them), returns matched examples; regex validation on input (reuse the safe-compile in `rules.ts`); show current default model when no rule matches; drag-to-reorder (rules array is ordered JSON — reorder = rewrite, no schema change). Then re-mount `RoutingRulesSection`.
**6d. Timeouts for the long-run era.**
- `tasks.timeout_minutes INTEGER` (nullable → provider default). Defaults move: claude/codex 30 min, gemini 10. Hard ceiling 120 min (`MAX_AGENT_TIMEOUT_MS`). AddTaskModal exposes it under "advanced". Timeout cause recorded distinctly (`failure_reason='timeout'`) — it's already a kill reason, make it legible in analytics.
**6e. Per-provider budget split (DD-BL-19, S):** budget rollup GROUP BY provider; pill modal shows claude vs codex vs antigravity rows. Data's already on the run rows.

**Tests:** codex argv/parse fixtures · preflight caching + failure states · gemini model rejection (regression for the silent no-op) · dry-run matching parity with `matchRoute` · timeout override respected · rollup split math.

---

### EP-7 — Verification verdicts (the trust layer)

**Problem.** A green gate says tests passed — not that the agent did the right thing. The 2026 differentiator is verification *evidence*. DryDock's cheapest strong move is the janitor verdict (DD-BL-30), which also mirrors the user's own adversarial-review ritual (multi-lens review, explicit disposition per finding).

**7a. Janitor verdict.**
- After gate-pass, finalization runs `claude -p --model claude-haiku-4-5 --permission-mode plan` in the worktree with: original prompt + `git diff` (EP-3's base_sha diff, truncated to ~8k lines) + gate output tail. Required output: JSON `{verdict: "pass"|"warn"|"reject", reasons: [..≤3], scope_creep: bool, prompt_coverage: "full"|"partial"}` (parsed defensively; unparseable → `verdict: "unknown"` — never a fabricated pass).
- Store `runs.janitor_verdict`, `runs.janitor_reasons`. `warn`/`reject` put the task in Needs attention with the reasons as chips ("Janitor: warn — addressed only part of the prompt"); they do **not** demote `done` → `failed` (advisory, not blocking — the human stays the gate). Cost of the janitor call is added to the run's cost (it's real spend; hiding it would be a confident wrong value in the budget).
- Per-project toggle `janitor_enabled` (default on for projects with a test_command, off otherwise).
**7b. Evidence hooks (design now, build later).**
- Schema stub done right this time (unlike `pr_url`): `run_artifacts` table `{id, run_id, kind('screenshot'|'recording'|'file'), path, label, created_at}` + `GET /api/runs/[id]/artifacts`. First producer: EP-8's scheduled UAT runs can drop screenshots via the existing drydock-uat skill machinery. Browser-recording verification à la Antigravity is explicitly future work — the table means it lands without another migration.
**Analytics tie-in:** failure_reason gains `janitor_reject`; analytics failure breakdown (already splits gate vs agent-exit) adds the third slice — closing the loop DD-BL-33 anticipated.

**Tests:** verdict JSON parsing (valid/malformed/absent) · unknown-verdict path · needs-attention integration · cost accumulation · artifacts CRUD.

---

### EP-8 — Scheduled dispatch + CI intake

**Problem.** The fleet only works when poked. Scheduled automations feeding a review queue are now first-class in the Codex app, Antigravity, and Devin.

**8a. Scheduler.**
- `schedules` table: `{id, project_id, title, prompt, cadence('daily'|'weekly'|'cron'), cron_expr, hour_local, enabled, last_run_at, last_task_id}`. In-process scheduler in the Node runtime (the Mac already stays awake for the tunnel): on boot + every 5 min, fire due schedules → create task → normal dispatch pipeline (queue-aware via EP-1c; capped at 1 concurrent scheduled run so a 3am fleet can't eat the budget). Missed windows (Mac asleep) run once on next boot if < 12h late, else skip and mark `missed` — never silently double-fire.
- Results land in Needs attention like any task (S3 scenario). CRUD UI: a "Schedules" section on the project page; global list in Settings.
- Guardrail: scheduled tasks always run `edits` autonomy or lower, regardless of project setting.
**8b. CI-failure intake (DD-BL-31, reduced and safer).**
- `POST /api/webhooks/github` verifying `X-Hub-Signature-256` HMAC (`GITHUB_WEBHOOK_SECRET` env; endpoint 404s when unset — fail closed). On `workflow_run.completed`+`conclusion=failure`: upsert a backlog item ("CI failing: <workflow> @ <head_sha:7>", external-id keyed on repo+workflow so repeats don't duplicate — the Apple Notes dedup lesson) + "CI broken" badge on the project card. **Intake only** — a human burns it down; auto-dispatch on CI failure is future opt-in.

**Tests:** due-schedule math incl. DST/missed-window · double-fire prevention (DB-level `last_run_at` CAS) · HMAC verification (reject unsigned/bad-sig — regression tests) · dedup on repeat failures.

---

### EP-9 — Test & process hardening (continuous)

Not a feature epic — the debt items the GitHub mining pass says the owner would flag in review:

1. **Put DryDock back on its own ritual.** Every epic above lands as a PR with `@codex review` + the multi-lens self-review + per-finding disposition ("Fixed in <sha>" replies) — no more direct-to-main feature waves. The repo that orchestrates agents should be the best-reviewed repo, not the only unreviewed one.
2. **App-layer tests.** Route handlers are the product's public API and have zero tests. Add vitest coverage for the high-risk ones as they're touched in EP-1…8 (run, cancel, followup, diff, pr, merge, webhooks) using the stub provider + temp SQLite (pattern already exists in dispatch tests). Also: `lib/db/analytics.ts` percentile math, `claude.ts`/`gemini.ts` argv construction (EP-1b/6a deliver these).
3. **Silent-failure audit.** One pass over `catch` blocks in `app/` + `lib/` — every swallow either surfaces to UI state or logs with context. (The RunningTasksPanel silent-error fix suggests there are siblings.)
4. **Supply chain.** New deps in this plan: `web-push` (EP-5), possibly a JWKS lib (EP-1, or hand-roll with `jose`). For each: check `vibe-coding-security/advisories`, exact-pin (no `^`), `npm ci --ignore-scripts` in any future CI, verify package names against the registry (slopsquatting check).
5. **Docs-as-memory.** Each epic updates AGENTS.md invariants (e.g. "SSE disconnect no longer kills the run — cancel is explicit"), issues.md for bugs found en route, and this file's status column.

---

## 7. Deferred items — and why

| Item | Why deferred |
|---|---|
| DD-BL-25 dependency graph / DD-BL-26 decomposer | High value, but sequencing work multiplies the value of threads+PRs — build the per-task loop first. Revisit after EP-2/3; the `queued` status and scheduler from EP-1/8 are stepping stones. |
| DD-BL-27 swarm / best-of-N | Cursor-style best-of-N needs comparative diff review — EP-3's DiffViewer is the prerequisite. Also 3× cost per task; wait for EP-7 verdicts to make winner-picking cheap. |
| DD-BL-29 per-project memory | The 2026 verdict on auto-knowledge-bases is "inconsistent everywhere". The `learnings` skill + docs-as-memory already covers this manually and better. Revisit only with a concrete retrieval win. |
| DD-BL-34 MCP server | Genuinely interesting (agents dispatching sub-tasks to DryDock) but it's a new attack surface pre-EP-1 and a new lifecycle pre-EP-2. Natural after both. |
| DD-BL-06 Turso | Single-machine SQLite is not the bottleneck for a one-human fleet; EP-5 notifications solve the "away from Mac" pain more cheaply. |
| DD-BL-17 Notes conflict UI / DD-BL-18 drag reorder | Notes sync is stable; don't disturb it for edge-case polish. |
| Mid-run interactivity (approval cards) | EP-2v2, explicitly staged after the one-shot→thread migration proves out. |

---

## 8. Success criteria

- **S1 executes end-to-end on a phone**: dispatch → walkthrough → diff → PR → (next morning) merge, without touching a terminal. This is the definition of done for EP-1…5.
- Tunnel URL access without auth shows a login wall; `curl` without a token gets 401 on every non-local route (verified by test).
- A follow-up turn on a finished task reuses its session and worktree, and the run chain renders as a thread.
- A cancelled run preserves partial output and diff; a dropped SSE connection kills nothing.
- Every failed/flagged task appears in Needs attention with a one-tap next action; nothing requires scanning project pages.
- A completion buzzes the phone with the walkthrough's first line while the PWA is closed.
- Codex is a dispatchable provider with health preflight; gemini either works or says why it can't — no silent no-ops.
- Every epic lands as a reviewed PR on the GitHub remote; new-code test coverage keeps the regression-test-per-bug ritual.

## 9. Open questions (decide during implementation, not blockers)

1. Antigravity CLI headless surface — spike result decides provider vs stub (EP-6b).
2. Cloudflare Access session length vs PWA UX — 30 days assumed; tune after a week of real use.
3. Walkthrough extraction robustness across providers — Claude honors the instruction reliably; Codex/Antigravity may need per-provider markers.
4. Whether `auto_pr` default flips on after a month of trust — revisit with EP-7 verdict data.
5. Queue policy under mixed scheduled + manual load (FIFO now; priority field exists on tasks if needed later).
