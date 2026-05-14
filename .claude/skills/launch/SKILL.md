---
name: launch
description: >
  Start the DryDock orchestrator dev server. Use whenever the user types
  "launch", "launch drydock", "start drydock", "run drydock", "start the
  dev server", "fire up drydock," or just opens the project and wants it
  running. Reuses an existing preview if one is already up; otherwise
  starts a fresh one on port 3000 (autoPort) and reports the URL.
compatibility: >
  Requires the Claude_Preview MCP (preview_start, preview_list,
  preview_logs) and a populated .claude/launch.json with a `drydock-dev`
  config (already present in this repo).
---

# launch — DryDock dev server launcher

## What this skill does

One-step launch of DryDock's dev server. Idempotent — running `launch`
when the server is already up just confirms it and prints the URL.

## How to invoke

In a session, the user can type any of:
- `launch`
- `/launch`
- `launch drydock`
- `start drydock`
- `start the dev server`
- `run drydock`

## Behavior

1. Call `preview_list` to see if a `drydock-dev` server is already running.
2. If it is, print the existing URL and a "(reused)" tag — don't restart.
3. If not, call `preview_start name: "drydock-dev"`.
4. Tail the server logs for ≤ 10 s waiting for `Ready in <Xms>`.
5. Print one short message to the user:
   `▲ DryDock running at http://localhost:<port> (server <id>).`
6. Take ONE screenshot and show it so the user has a visual confirmation
   the page loaded. Don't snapshot, don't navigate, don't click — this
   skill is just "make the thing visible."

## Boundaries

- **Do not** dispatch any agent tasks, click into modals, or run UAT.
- **Do not** stop other preview servers — leave them running.
- **Do not** install dependencies (`npm install`). If the server fails to
  start because `node_modules` is missing, surface the error and ask the
  user to run `npm install` first.
- If the server fails for any other reason, dump the last 20 lines of
  `preview_logs` and let the user decide.

## When the user asks for more

If the user follows up with "stop drydock" or "kill the server," call
`preview_stop` against the active server id. Don't kill servers for
other apps.

If the user asks for the URL of an existing server, prefer
`preview_list` (cheap) over starting a new one.
