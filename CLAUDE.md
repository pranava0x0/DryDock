# DryDock — Project Notes

> This file extends the [universal CLAUDE.md](../CLAUDE.md) with DryDock-specific working agreements. The universal principles apply by default; the items below override or specialize them for DryDock. When the universal file conflicts with [AGENTS.md](AGENTS.md), AGENTS.md wins — it's the local source of truth.

This directory is the [DryDock orchestrator](README.md) — all three phases shipped 2026-05-12, followed by Apple Notes hardening + auto-sync + edit-in-place + cross-project running-tasks panel + opt-in worktree GC + gate-output replay in May 2026 (see [drydock-backlog.md](drydock-backlog.md)).

- **Tech stack** and project-specific working agreements: [AGENTS.md](AGENTS.md) — read this **first** when touching anything Apple-Notes-related; it documents the id-stable write, body-first-line / title alignment, mutex, last-sync-at semantics, and the full conflict resolution cheat sheet.
- **Visual system** (colors, spacing, touch targets, icon set): [design.md](design.md)
- **Active bugs / fixed bugs**: [issues.md](issues.md) — every Apple Notes failure mode (`-10000`, `-1728`, non-deterministic enumeration, body-vs-name mismatch, add-then-sync duplication) has its own DD-### entry. Cross-reference before touching that code path.
- **Product backlog** (DryDock-specific): [drydock-backlog.md](drydock-backlog.md). The portfolio-level [`../BACKLOG.md`](../BACKLOG.md) is unrelated cross-project work.
- **Supply-chain advisory log**: [`../security.md`](../security.md). **Read before any `npm install` / `pip install` / dep upgrade.** Refresh if `Last updated` is >7 days old.
- **Local dev:** `npm run dev` from this directory. The dev launch config is `drydock-dev` in [`../.claude/launch.json`](../.claude/launch.json) — or just type "launch" in a Claude Code session.
- **Setup checklist** (Cloudflare Tunnel + CLI auth + Apple Notes): [docs/setup.md](docs/setup.md).

## DryDock-specific working agreements (overrides on top of the universal CLAUDE.md)

- **Don't add another auto-sync trigger** without checking [components/useAutoSync.ts](components/useAutoSync.ts) first. The dashboard mounts it one-shot; `/backlog` mounts it with `intervalMs: 30_000`. Both share the server-side `inFlightSync` mutex so duplicate triggers are harmless but wasteful.
- **Backlog status `dropped` is legacy** — the UI no longer exposes Drop. Existing rows with `status='dropped'` still get filtered out of the Apple Notes push, but new user actions are limited to Burn down / Mark done / ✏️ Edit / 🗑️ delete.
- **Don't loosen Apple Notes' `irreversible done` rule.** A checked box in Notes promotes the DB to `done`; un-checking is intentionally ignored. The user can re-open via UI explicitly.
- **Don't add a second canonical-note discovery path.** The `apple_notes_note_id` setting is authoritative; everything else is fallback. If you find yourself adding new search heuristics, write a test first that proves the id-stable path can't handle the case.
