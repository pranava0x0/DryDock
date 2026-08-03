# DryDock Setup

End-to-end checklist for getting DryDock running on a Mac with mobile access via Cloudflare Tunnel. Nothing here requires an API key.

## 1. Prerequisites

- macOS with Node ≥ 20 (Node 22 recommended — matches local dev)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated (`claude` on `$PATH`)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated (`gemini` on `$PATH`) — only required if you plan to dispatch tasks to Gemini
- Homebrew (used to install `cloudflared`)

Verify both CLIs work standalone before continuing — DryDock just subprocesses them, so anything that breaks at the shell will break here too:

```bash
claude --print "say hi"
gemini -p "say hi"
```

## 2. Install dependencies

```bash
cd /Users/<you>/Documents/Projects/DryDock
npm install
```

`better-sqlite3` includes a native build step. If npm complains about missing Python or Xcode CLT, install them with `xcode-select --install`.

## 3. Configure environment

```bash
cp .env.example .env.local
```

The only required variable is `DRYDOCK_DB_PATH`. Default points at `~/.drydock/drydock.db` — the directory is created automatically on first run. The DB file lives outside the repo so it never gets committed by accident.

`.env.local` is gitignored. There is no secret to configure — DryDock authenticates the agent CLIs via their own OAuth sessions at `~/.claude/` and `~/.gemini/`.

## 4. Run locally

```bash
npm run dev
```

Open http://localhost:3000. Three landings on the dashboard:

- **Default** — list of registered projects. Click **+ FAB** to add one manually. The **New session** button next to the Projects heading opens the one-call composer (prompt → dispatch, see §12).
- **Discover** (top-right link) — scans `~/Documents/Projects` (or whatever `DRYDOCK_PROJECTS_ROOT` points at) and shows every subdir with detected stack chips (next / node / python / rust / go / ruby / php). One-click **Import** sets a sensible default quality-gate command.
- **Backlog** (top-right link) — global cross-project idea list. Add an idea, assign it to a project, hit **🔥 Burn down** to materialize it as a Pending task.

Each project page has a **Project docs** panel that lazy-loads the project's own `issues.md` / `backlog.md` / `CLAUDE.md` / `AGENTS.md` / `design.md` / `README.md` inline.

### 4a. Set a monthly budget (optional)

Click the `$` pill in the page header → set your monthly limit. DryDock sums every `cost_usd` reported by `claude` against the limit and fires a banner + browser Notification when you cross 50% / 80% / 100% of the budget. The first save prompts for browser notification permission.

### 4b. Sync the global backlog with Apple Notes (optional, Mac-only)

On the **Backlog** page, hit **↻ Sync Notes**. The first run prompts for macOS automation permission to control the Notes app. Grant it in System Settings → Privacy & Security → Automation. DryDock then reads/writes a single note titled "DryDock Backlog" (configurable via the API).

Use it from your phone by typing checkboxes into the same note in Apple Notes — they round-trip back into DryDock on the next sync.

## 5. Cloudflare Tunnel (one-time)

```bash
brew install cloudflared
cloudflared tunnel login                 # opens a browser
cloudflared tunnel create drydock        # writes ~/.cloudflared/<UUID>.json
```

Copy the tunnel UUID into `.cloudflared/config.yml` (replace `REPLACE_WITH_TUNNEL_ID` and `REPLACE_WITH_USERNAME`). The template in the repo only contains placeholders — the actual credentials file stays under `~/.cloudflared/` and is never committed.

```bash
cloudflared tunnel run drydock
```

Cloudflare prints a public `*.cfargotunnel.com` URL. Bookmark it on your phone and use Safari → Share → Add to Home Screen. The PWA `manifest.json` makes it open standalone (no browser chrome).

Auto-start on Mac login (optional):

```bash
sudo cloudflared service install
```

## 6. Keep the Mac on

Cloudflare Tunnel relies on your local Node server staying reachable. In System Settings → Battery → Options, set "Prevent automatic sleeping when the display is off" to ON.

## 7. Sanity checks

- `npm run typecheck` — no type errors
- `npm test` — vitest suite passes
- `curl http://localhost:3000/api/projects` — returns `{"projects": []}` on a fresh install

## 8. Capture from your phone (Siri / Shortcuts)

The fastest way into the backlog: one spoken sentence, phone still
locked. This is the only capture channel that needs **no unlock** — the
PWA quick-add and a text-to-self both require getting past the lock
screen first, which is exactly the friction that loses ideas.

Everything below is a one-time setup on the iPhone. It sends to
`POST /api/capture`, which lands the item in the **inbox**, not the
backlog — you sweep it later with one tap per item.

### Build the Shortcut

Shortcuts app → **+** → add these actions in order:

1. **Ask for Input**
   - Input type: `Text`
   - Prompt: `Capture` (anything short — you'll rarely see it)
   - *This is the important one*: when a Shortcut is invoked **by Siri**,
     `Ask for Input` becomes voice dictation automatically. No extra
     configuration, and no screen required.
2. **Get Contents of URL**
   - URL: `https://<your-tunnel-host>/api/capture`
   - Method: `POST`
   - Headers:
     - `Authorization` → `Bearer <your DRYDOCK_AUTH_TOKEN>`
     - `Content-Type` → `application/json`
   - Request Body: `JSON`
     - `text` → the *Provided Input* variable from step 1
     - `idempotency_key` → a *Current Date* formatted to something
       unique (Shortcuts has no UUID action). This is what makes a retry
       over a flaky tunnel safe — without it, one dropped response is two
       identical rows to sweep in the morning.
3. **If** — *Get Contents of URL* `has any value`
   - **Otherwise**: **Append to Note** → a note called `Capture fallback`,
     with the Provided Input.
     *Don't skip this branch.* If the tunnel is down or the Mac is
     asleep, the request fails silently and the thought is gone. A
     fallback note means the worst case is "it's in the wrong place"
     rather than "it never existed".

Rename the Shortcut to your trigger phrase — **"Quick add"** works well
because Siri hears it reliably and it isn't a phrase you'd say by
accident.

### Use it

> "Hey Siri, quick add" → *(chime)* → "rate limiter for the tunnel
> endpoints p2 hashtag drydock"

Next time you open DryDock, it's in the Inbox with `p2` and the project
already parsed, plus the raw text you actually said in case the parse got
it wrong.

### Markers

Optional, and only at the **end** of what you say:

| Marker | Effect |
|---|---|
| `#project-name` | Assigns the project. Fuzzy-matched — `#drydock` finds "DryDock", `#robotics` finds "Robotics Leadership". An **ambiguous** match assigns nothing rather than guessing. |
| `p1` … `p4` | Priority, `p1` highest. |

Say them last. "Fix the #2 bug in p1 mode" is a title, not a project
called "2" — the parser only reads markers as a trailing suffix, so
normal speech is safe.

### Notes and caveats

- **The token lives in the Shortcut.** Rotating `DRYDOCK_AUTH_TOKEN`
  means editing the Shortcut's header. There's no way around this
  without inventing a second secret, which is the thing DryDock
  deliberately doesn't do.
- **Test it from the terminal first**, before trusting it with a real
  idea:
  ```bash
  curl -X POST https://<your-tunnel-host>/api/capture \
    -H "Authorization: Bearer $DRYDOCK_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"text":"test capture p3","idempotency_key":"setup-test-1"}'
  ```
  A second run with the same key must return `"outcome":"duplicate"` —
  that's the retry-safety working.
- **The Shortcut itself isn't unit-tested** (it lives on the phone). The
  endpoint it calls is. Verify the Shortcut by using it.

## 9. Connect the satellites (MCP)

DryDock exposes a small MCP server so other Claude Code sessions — the
nightly idea generator, the Daily Briefing job — can read the backlog and
propose items without opening the database themselves.

Register it once per satellite:

```bash
claude mcp add --scope user drydock -- npx tsx /absolute/path/to/DryDock/mcp/server.ts
```

### What it can and can't do

| Tool | What it does |
|---|---|
| `add_backlog_item` | **Proposes** an item. Lands in the inbox, never the backlog, never the Apple Note. |
| `list_backlog` | Reads the accepted list (or the inbox, on request). |
| `list_tasks` / `get_task_status` | Reads orchestrator state — "what needs attention". |
| `get_usage_stats` | AI usage over a recent window, from the local ledger. |
| `burn_down_item` | Turns an **accepted** item into a *pending* task. |

**`dispatch_task` is not exposed, and that's deliberate.** The primary
consumer reads untrusted web content; giving it the ability to start an
agent would complete the lethal trifecta — untrusted input, private data,
and a way to act. The most a hostile page can achieve through this
surface is proposing an inbox item, which you sweep with one tap.
`burn_down_item` is the boundary case and is allowed because the task it
creates is *pending*: a human still has to press Run. That's the same
line the UI already draws.

The withheld list is written down explicitly in
[lib/mcp/tools.ts](../lib/mcp/tools.ts) (`WITHHELD_TOOLS`) so the omission
reads as a decision rather than an oversight — and so adding dispatch
later reads as the deliberate reversal it would be.

### Caller identity

Set by the environment, never by the caller:

```bash
DRYDOCK_MCP_CALLER=ai-generated   # default — proposals land as `proposed`
DRYDOCK_MCP_CALLER=manual         # a human-driven session
```

It defaults to the *less* trusted identity on purpose: a
misconfiguration should under-trust, never over-trust. The tool forces
this value into every write, so a caller passing `source: "manual"` in
its arguments has no effect.

### Verify it

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | npx tsx mcp/server.ts
```

You should see six tools, and `dispatch_task` should not be among them.

## 10. Keep it running (launchd) and the TCC caveat

Everything scheduled — the 7am digest, the nightly idea import — assumes
the Mac is awake and DryDock is reachable. Two things make that true, and
one of them has a trap in it.

### The trap: Full Disk Access does not survive launchd

`~/Library/Messages/chat.db` is TCC-protected. The Next.js server
**inherits** Full Disk Access from the terminal that launched it, so a
DryDock started by hand from an FDA-granted Terminal can read it — and
the same DryDock started by `launchd` **cannot**.

That affects exactly one feature, the iMessage capture channel (§11), and
it fails honestly: the channel reports "no Full Disk Access" with the fix
rather than quietly capturing nothing.

So pick per what you use:

- **Using iMessage capture?** Keep launching from an FDA-granted
  terminal. Grant it under System Settings → Privacy & Security → Full
  Disk Access.
- **Not using it?** launchd is fine, and everything else in DryDock is
  TCC-free.

### The plist

```xml
<!-- ~/Library/LaunchAgents/com.pranava.drydock.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pranava.drydock</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npm</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/pranava/Projects/DryDock</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/drydock.log</string>
  <key>StandardErrorPath</key><string>/tmp/drydock.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.pranava.drydock.plist
```

Run a production build first (`npm run build`) — `npm start` serves that,
and `ACTIVE_RUNS` only behaves correctly in a single production server
anyway (see AGENTS.md on the dev-mode cancel caveat).

### Watchdog

`KeepAlive` restarts a crashed process but says nothing about a process
that is up and broken. Scheduled jobs that depend on a local surface
should **log and alert** when a dependency is down rather than failing
silently — the connector health states exist precisely so a job can check
before it reports.

There is a documented `claude -p` hang under launchd; that's why the
briefing runs as a Claude Code **Desktop Scheduled Task** rather than a
launchd job, and only the server is managed here.

## 11. Text yourself an idea (iMessage)

The channel with the most existing muscle memory and the most moving
parts. Built last on purpose: it is slower than Siri (~4–6s, and it needs
the phone unlocked) and considerably more fragile.

Enable it in Settings, or:

```bash
curl -X POST http://localhost:3000/api/capture/imessage \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"self_handle":"+15555550123"}'
```

`self_handle` is **the number or email you text yourself at**, and it is
required — a Mac has several handles and guessing would silently watch
the wrong thread, which looks identical to a broken feature.

Enabling seeds the cursor at your newest message. Without that, the first
poll would walk back through years of texts and file every one that ever
started with "idea:".

### Using it

> **idea:** rate limiter for the tunnel endpoints

The `idea:` prefix is required by default so texting yourself a grocery
list doesn't become a backlog item. Clear it (`{"trigger":""}`) to
capture everything you send yourself.

### What it does about the hard parts

- **52% of messages on this Mac have a NULL `text` column** and store the
  body only in `attributedBody`, a serialized NSAttributedString. DryDock
  decodes it ([lib/integrations/typedstream.ts](../lib/integrations/typedstream.ts)),
  validated against 4,000 real messages that have both fields — 4,000
  exact matches, zero mismatches.
- **A message it can't decode still becomes an inbox row**, labelled
  "text unreadable — open Messages". Silently skipping would lose a
  thought with no trace that anything happened.
- **Full Disk Access** — see §10. `health()` reports the real reason.

## 12. Kick off sessions from the phone — and the security model

The dashboard's **New session** button (`/session/new` in the PWA) is a
one-call composer: pick a project, type a prompt, optionally override the
model or autonomy under **Advanced**, tap **Start session**. `POST
/api/sessions` creates the task (title = the prompt's first line) and
dispatches it in the same request; you land on the project page with the
live stream already open — or with a queue badge when the concurrency cap
is full (202, the task drains FIFO).

Because it rides the normal dispatch pipeline, everything else just works:
the run streams over SSE, survives your phone locking, takes follow-up
turns via `--resume`, and can be cancelled remotely.

### What that endpoint is, stated plainly

An authenticated POST that spawns a `claude` subprocess on this Mac with
file-edit permissions — and under `full` autonomy, arbitrary Bash — inside
a repo worktree. Anyone who can call it can change code on this machine.
It is remote code execution **by design**; authentication is the security
story, and everything below is a layer around that fact.

### Why subscriptions instead of API keys

- **No secret exists in the web tier to steal.** The dispatcher inherits
  `PATH`/`HOME` only; the CLI reads its own OAuth session under
  `~/.claude/`. Compromising the app yields no `ANTHROPIC_API_KEY`,
  because there isn't one — a repo working agreement, not an accident.
- **Subscription quota bounds the damage.** A hijacked dispatch burns
  plan headroom, not an unmetered pay-per-token key.
- **Revocation is `claude logout` on this Mac**, not a key rotation
  hunted across configs.

### The layers around a dispatch

| Layer | What it bounds |
|---|---|
| Front-door auth (§5) — Cloudflare Access or token, **fail-closed** when neither is set | who can reach any route at all; the `SameSite=Lax` cookie also makes cross-site POSTs (CSRF) a non-starter |
| Autonomy profile — `readonly` (plan only) / `edits` (file edits + a 7-command Bash allowlist) / `full` (edits + any Bash) | what the subprocess may do; `--dangerously-skip-permissions` is never emitted, regression-pinned in `lib/providers/claude.test.ts` |
| Per-task git worktree | the agent works on a branch fork, not your checkout — misbehavior is inspectable and discardable |
| Concurrency cap + FIFO queue | a spammed or hijacked endpoint starts at most `max_concurrent_runs` agents; the rest queue visibly |
| Kickoff rate limit (burst 10, refill 10/min, in-process) | throttles a stolen-credential burst; resets on restart — a layer, not a substitute for auth |
| Prompt cap (20k chars) + `tasks.source = 'session'` | bounds stored input; `source` + `created_at` + the full transcript answer "what started this run?" |
| Path preflight (DD-017) | a stale project path fails with a 409 naming the path instead of a cryptic worktree ENOENT mid-run |
| 10-min subprocess timeout + quality gate | runaways get killed; "agent exited 0 but tests fail" demotes to failed |

### What `full` autonomy means through a tunnel

A phone-reachable button that runs arbitrary shell as your user. That's
sometimes exactly what you want — but keep projects on `edits` and treat a
per-session `full` (the composer's Advanced section) as a deliberate,
visible escalation: the transcript's `[drydock] autonomy profile:` line
records it per run.

### Hosting options, ranked

1. **Localhost only** — don't run the tunnel; or run it with
   `DRYDOCK_LOCAL_DISPATCH_ONLY=1`, which keeps remote view/stream/cancel
   working but rejects remote kickoff, `/run`, and `/followup` (dispatch
   then requires being at the Mac). The most conservative posture.
2. **Cloudflare Access in front of the tunnel** *(recommended remote
   setup)* — real identity + MFA at the edge; the origin re-verifies the
   `Cf-Access-Jwt-Assertion` JWT, so a leaked tunnel URL alone is useless.
3. **Shared token** (`DRYDOCK_AUTH_TOKEN`) — acceptable single-user
   floor. Generate 32+ random bytes, enter it once at `/auth` (30-day
   httpOnly cookie), rotate on any suspicion.
4. **Unauthenticated — never.** With neither auth mode configured the
   middleware refuses every non-local request (fail closed); leaving it
   that way requires deliberate effort. Keep it that way.

### Honest residual risks

- **Prompt injection on the agent.** A malicious file, issue, or web page
  the agent reads can steer it *within its autonomy envelope*. That's the
  same lethal-trifecta reasoning that keeps dispatch tools off the MCP
  surface (§9) — the mitigation is the autonomy profile and the worktree,
  not wishful prompting.
- **Token theft from the phone.** A stolen 30-day cookie dispatches until
  rotated. Cloudflare Access (option 2) moves that risk to an IdP with
  MFA; the rate limit and cap bound the blast while it lasts.
- **The rate limit is in-process.** A restart refills it. It exists to
  slow a burst, not to gate a determined authenticated attacker — that's
  what auth mode choice is for.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `claude: command not found` in the agent output | `claude` isn't on the PATH visible to the Next.js process. Start `npm run dev` from a shell that resolves it. |
| Stream stays empty forever | The CLI is prompting for auth. Run it once at the terminal to complete its OAuth flow. |
| "Task is not pending" 409 | Two clicks reached `/run` within the same poll window. Refresh the page — the first dispatch is still in flight. |
| DB locked errors under heavy use | We're on SQLite with WAL; a Turso migration is tracked as DD-BL-06 (deferred — see [improvement-plan-2026-07.md](improvement-plan-2026-07.md) §7: single-machine SQLite isn't the bottleneck for a one-human fleet). |
