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

- **Default** — list of registered projects. Click **+ FAB** to add one manually.
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

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `claude: command not found` in the agent output | `claude` isn't on the PATH visible to the Next.js process. Start `npm run dev` from a shell that resolves it. |
| Stream stays empty forever | The CLI is prompting for auth. Run it once at the terminal to complete its OAuth flow. |
| "Task is not pending" 409 | Two clicks reached `/run` within the same poll window. Refresh the page — the first dispatch is still in flight. |
| DB locked errors under heavy use | We're on SQLite with WAL; a Turso migration is tracked as DD-BL-06 (deferred — see [improvement-plan-2026-07.md](improvement-plan-2026-07.md) §7: single-machine SQLite isn't the bottleneck for a one-human fleet). |
