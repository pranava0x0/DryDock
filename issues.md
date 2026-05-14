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
