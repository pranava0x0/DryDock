# ⚓ DryDock

A personal project orchestrator. Dispatches coding tasks to [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Gemini CLI](https://github.com/google-gemini/gemini-cli) subprocesses, isolates every task in its own `git worktree`, and streams the agent's live output to a mobile-first PWA you can pin to your phone home screen.

There are no API keys. Auth is delegated to the CLIs' own OAuth sessions on your Mac.

```
┌──────────────┐   POST /run    ┌──────────────────┐
│  iPhone PWA  │ ─────────────► │  Next.js 15 app  │
│  (Cloudflare │ ◄─────────────│  + better-sqlite3 │
│   Tunnel)    │   SSE stream   │  + Node spawn    │
└──────────────┘                └──────┬───────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ git worktree add │ → claude --print ... │ → /dev/null
                              └──────────────────┘
```

## What's inside

| Feature | Where |
|---|---|
| Dashboard, project detail, mobile-first PWA shell | [app/page.tsx](app/page.tsx), [app/project/[id]/page.tsx](app/project/%5Bid%5D/page.tsx) |
| Per-task git worktree isolation | [lib/orchestrator/worktree.ts](lib/orchestrator/worktree.ts) |
| Quality-gate (`npm test` after agent exits) | [lib/orchestrator/gate.ts](lib/orchestrator/gate.ts) |
| Cost capture from `claude --output-format stream-json` | [lib/providers/claude-parse.ts](lib/providers/claude-parse.ts) |
| Monthly budget rollup + threshold notifications | [lib/budget/rollup.ts](lib/budget/rollup.ts), [components/BudgetWidget.tsx](components/BudgetWidget.tsx) |
| `/discover` view of `~/Documents/Projects` | [app/discover/page.tsx](app/discover/page.tsx) |
| Global cross-project backlog + Apple Notes sync | [app/backlog/page.tsx](app/backlog/page.tsx), [lib/integrations/apple-notes.ts](lib/integrations/apple-notes.ts) |
| Project-doc viewer (read `issues.md` / `CLAUDE.md` etc per project) | [components/ProjectDocs.tsx](components/ProjectDocs.tsx) |

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. Full Mac → phone setup (Cloudflare Tunnel + CLI auth + Apple Notes permissions) lives in [docs/setup.md](docs/setup.md).

## Skills

Two project-specific Claude Code skills live in [`.claude/skills/`](.claude/skills):

- **`launch`** — type "launch" in any Claude Code session and the dev server comes up via `preview_start`.
- **`drydock-uat`** — lightweight UAT for this app: walks the UX flows, audits perf + data efficiency, never dispatches real agents (uses `DRYDOCK_PROVIDER_STUB=1` as a token-free escape hatch).

## Working agreements for agents

[AGENTS.md](AGENTS.md) has the tech invariants and file map. Default reading for any AI agent that opens this repo.

## Design system

[design.md](design.md) — Seattle Kraken-inspired palette (Deep Sea Blue + Ice + Red Alert), anchor + crane motif, mobile-first touch targets ≥ 44px.

## Status

- [x] Phase 1 — Core orchestrator (Next.js + SQLite + SSE)
- [x] Phase 2 — Per-task `git worktree add` isolation
- [x] Phase 3 — Quality gates, cost tracking, retry
- [x] Kraken theme + anchor/crane motif
- [x] `launch` + `drydock-uat` Claude Code skills
- [x] Project discovery + per-project doc viewer
- [x] Monthly budget rollup + threshold notifications
- [x] Global backlog + bidirectional Apple Notes sync

Open items live in [drydock-backlog.md](drydock-backlog.md) and [issues.md](issues.md).

## License

Personal project. No license — don't redistribute.
