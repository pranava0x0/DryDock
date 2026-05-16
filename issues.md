# DryDock — Issues

Per universal CLAUDE.md: every bug encounter and fix gets logged here. Active table stays ≤ 20 rows; fixed bugs move to the Resolved Summary as one-liners.

## Active Issues

| ID | Date | Area | Description | Severity | Size | Cause | Status |
|---|---|---|---|---|---|---|---|

(none — Phase 1 just shipped)

## Resolved Summary

| ID | Date | Description | Fix |
|---|---|---|---|
| DD-001 | 2026-05-12 | SSE stream hung indefinitely when subscribing to a run whose hub history was wiped (Next.js dev HMR) — the subscriber waited forever on a freshly-created empty entry. | [app/api/tasks/[id]/stream/route.ts](app/api/tasks/[id]/stream/route.ts) now branches on `getActiveRunController(runId)`; terminal runs replay from the DB directly instead of subscribing. Caught by curling the endpoint during browser-preview verification. |
| DD-002 | 2026-05-12 | Stream-route fallback enqueued `runs.output` only, so a failed run with empty stdout (spawn ENOENT) showed nothing in the UI. | Added `error` replay to `replayFromDb()` in [app/api/tasks/[id]/stream/route.ts](app/api/tasks/[id]/stream/route.ts). Verified in preview: failure now renders the stderr line + exit code. |
| DD-003 | 2026-05-14 | SSE subscribers terminated at the agent's `exit` event, hiding everything that ran after — quality-gate transcript, worktree-cleanup notes, the actual outcome. | Dispatcher now suppresses the provider's exit event and synthesizes a single terminator after gate + auto-cleanup. `replayFromDb` extracted to [lib/orchestrator/replay.ts](lib/orchestrator/replay.ts) and now surfaces `runs.gate_output` under its own header. Shipped in commit `f8bf59d`. |
| DD-004 | 2026-05-14 | Apple Notes sync silently created a duplicate `DryDock Backlog` note on *every* transient AppleScript error. Root cause: a single `try {…} on error { make new note }` block treated every failure as "doesn't exist." | [lib/integrations/apple-notes.ts](lib/integrations/apple-notes.ts) `buildWriteScript` replaced the try/on-error catch-all with an explicit existence check (count of matches) + per-candidate write. Regression-pinned with a negative-assertion test. Shipped in `547b18f`. |
| DD-005 | 2026-05-14 | `set body` raised `-10000 ("Can't modify a note in Recently Deleted")` for trashed candidates, aborting the whole sync. | Switched to a try-each-candidate loop: each writable match is attempted in turn; -10000 falls through to the next. `make new note` only runs when every candidate has failed. Shipped in `20c22c2`. |
| DD-006 | 2026-05-14 | Even with V3, the `/backlog` page polling appeared to keep creating new notes. AppleScript's `every note whose name is X` enumerates in non-deterministic order, so each sync touched a *different* writable duplicate — looked indistinguishable from "still creating new notes." | Persist the canonical note's stable Apple Notes id (`apple_notes_note_id`) after the first successful write; subsequent writes target `note id "…"` directly. By-name search is fallback only. Shipped in `80e8808`. |
| DD-007 | 2026-05-14 | Even with the id-stable write, V5 *also* fell through to `make new note` on the first sync after deploy. Cause: `DEFAULT_NOTE_TITLE` was `"DryDock Backlog"`, but Apple Notes derives the note's name from the body's **first line** (`"⚓ DryDock Backlog"`) and ignores the `name` we pass. By-name search matched 0 of 10 existing notes. | `DEFAULT_NOTE_TITLE` updated to include the anchor; renderer accepts `title` and emits it as the body's first line so they stay aligned by construction. One-time migration auto-upgrades stored `apple_notes_title` from the legacy value. Shipped in `a739386`. |
| DD-008 | 2026-05-15 | Type an item in the DryDock UI, click "Sync Notes" → the item appeared **twice** in the note. Manual rows had `external_id = null`, so the next sync's by-external_id lookup missed and a second `apple-notes`-sourced row was created with the same title. | `POST /api/backlog` now stamps `external_id = lineId(title)` at row creation. `syncWithAppleNotes`'s pull phase also adds a title-claim fallback that adopts pre-existing null-id rows in place. Shipped in `6133d1d`. |
