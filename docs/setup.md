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

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `claude: command not found` in the agent output | `claude` isn't on the PATH visible to the Next.js process. Start `npm run dev` from a shell that resolves it. |
| Stream stays empty forever | The CLI is prompting for auth. Run it once at the terminal to complete its OAuth flow. |
| "Task is not pending" 409 | Two clicks reached `/run` within the same poll window. Refresh the page — the first dispatch is still in flight. |
| DB locked errors under heavy use | We're on SQLite with WAL; if you ever need more concurrency, Phase 3 plans a Turso migration. |
