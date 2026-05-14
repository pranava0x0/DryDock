# DryDock — Project Notes

> This file extends the [universal CLAUDE.md](../CLAUDE.md) with DryDock-specific working agreements. The universal principles apply by default; the items below override or specialize them for DryDock. When the universal file conflicts with [AGENTS.md](AGENTS.md), AGENTS.md wins — it's the local source of truth.

This directory is the [DryDock orchestrator](README.md) — all three phases shipped 2026-05-12.

- **Tech stack** and project-specific working agreements: [AGENTS.md](AGENTS.md)
- **Visual system** (colors, spacing, touch targets): [design.md](design.md)
- **Active bugs / fixed bugs**: [issues.md](issues.md)
- **Product backlog** (DryDock-specific): [drydock-backlog.md](drydock-backlog.md). The portfolio-level [`../BACKLOG.md`](../BACKLOG.md) is unrelated cross-project work.
- **Supply-chain advisory log**: [`../security.md`](../security.md). **Read before any `npm install` / `pip install` / dep upgrade.** Refresh if `Last updated` is >7 days old.
- **Local dev:** `npm run dev` from this directory. The dev launch config is `drydock-dev` in [`../.claude/launch.json`](../.claude/launch.json) — or just type "launch" in a Claude Code session.
- **Setup checklist** (Cloudflare Tunnel + CLI auth + Apple Notes): [docs/setup.md](docs/setup.md).
