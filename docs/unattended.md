# Unattended Mode for OpenCode sessions

Flip a live session into unattended/overnight mode by sending:

```
I'm going to bed — /unattended — see you tomorrow morning.
```

While active, the agent will not block on questions: it makes conservative,
reversible decisions, logs each one, refuses irreversible/destructive actions
(logging them as escalations), and writes a summary at the end.

The mode is **per session**, not per project. Two sessions in the same project
never share it: starting one does not flip the other, and turning one off does
not touch the other.

## Files

All paths are inside the `opencode-custom` package:

| Path | Purpose |
| --- | --- |
| `lib/unattended.js` | V2 plugin — hooks, markers, contract/notice injection, idle nudges |
| `lib/unattended-state.js` | Per-session state (durable `ctx.storage`, file fallback) and artifact paths |
| `rpc.js` | The `unattended` RPC contract — `status` method, `changed` event |
| `tui.jsx` | TUI plugin source — the sidebar badge of the active session |
| `tui.js` | Compiled `./tui` entry shipped to OpenCode (generated from `tui.jsx`) |
| `scripts/build-tui.mjs` | Builds `tui.jsx` → `tui.js` (OpenCode's Solid/OpenTUI transform) |
| `lib/indicator.js` | The badge state machine (unknown is not off) |
| `commands/unattended.md` | `/unattended` — enter the mode (registered by the plugin) |
| `commands/unattended-off.md` | `/unattended-off` — hand back mid-session (keep running, write an unattended-only summary) |
| `skills/unattended/SKILL.md` | The full contract, loaded by the agent |
| `skills/unattended/scripts/unattended-digest.sh` | Renders decisions + escalations (stdout; notification deferred) |
| `skills/unattended/scripts/unattended-selftest.mjs` | Acceptance self-test (mock ctx, no live model needed) |

State and artifacts are written **per session**, into the session's current
project:

```
<project>/.opencode/unattended/sessions/<session-id>/
├── decisions.jsonl  # one JSON object per line
├── DECISIONS.md     # human-readable bullet log
├── SUMMARY.md       # end-of-run or handover summary
├── record.json      # file fallback only
├── ACTIVE           # file fallback only: existence = armed
└── plugin.log       # only when UNATTENDED_DEBUG=1
```

`<project>/.opencode/unattended/ACTIVE` (project-wide) is **legacy**: the plugin
never reads or writes it, so an old sentinel arms nobody. You can delete it by
hand.

## How it survives the night

The slash command is only a soft prompt. The plugin is what actually makes the
mode durable:

1. **Deterministic arming.** `session.hook("prompt")` sees the
   `[[opencode-unattended:on]]` marker and arms that session's record itself —
   it does not trust the model to write state. (A `context`-hook bootstrap
   scans user messages only when the session has no record yet; once a record
   exists, history is never re-scanned, so a stale ON cannot re-arm.)
2. **Compaction survival.** `session.hook("context")` runs before every
   agent-loop model request and, while the session is armed, pushes a compact
   contract into `event.system`. Because that happens per request — including
   right after a compaction — the contract cannot be silently lost.
3. **Idle nudges.** `ctx.event.subscribe()` watches `session.idle`; if the
   session is armed the plugin queues a "do not wait for me" prompt. Nudges are
   debounced, capped, and scoped to the session.
4. `session.compacted` events are logged so you can see re-injection happened.
5. **Natural end.** When the agent ends its final message with
   `[[opencode-unattended:off]]`, the plugin sees it at idle and disarms the
   session silently.

## The badge in the TUI

The terminal shows the state of the **active session** in the sidebar:

```
● unattended   amber — this session is running unattended
○ unattended   dim   — this session is known to be in normal mode
(nothing)             — the state is unknown
```

- The badge is bound to the session the sidebar shows, so two open sessions
  never share a state.
- **Unknown is not off.** When the plugin cannot ask the server (the server
  half is not installed, the server is unreachable, the RPC is not registered)
  the badge shows nothing. A badge that claims "off" while the truth is "I do
  not know" would be worse than no badge.
- It updates live: the server plugin emits a `changed` event when a session is
  armed or disarmed, and the TUI repaints.
- The server plugin stays the source of truth. The TUI only reads — it asks the
  `unattended` RPC (`rpc.js`) for the state of a session.
- The installed entry is `tui.js`, compiled from `tui.jsx`: OpenCode does not
  apply its JSX transform to files inside `node_modules`. After editing the
  source, run `npm run build:tui` and reinstall/update the plugin.
- The home screen has no sidebar, so the badge only shows in a session view.

Set `UNATTENDED_DEBUG=1` to see what the TUI half is doing in
`<project>/.opencode/unattended/tui.log`.

## Use

```
/unattended        # enter unattended mode for THIS session
/unattended-off    # hand back mid-session; keep working, ask questions again
```

`/unattended-off` is a handover, not a shutdown:

- the current task keeps running and is not re-planned;
- on the next request the plugin injects a one-shot off notice;
- the agent writes `SUMMARY.md` for the unattended window only (decisions at or
  after `armedAt`, excluding mode meta events) and presents it;
- from then on the session behaves as if unattended mode had never started.

## Digest

```bash
unattended-digest.sh [--session <id>] [project-dir]
```

With no `--session`, a project with exactly one session directory uses it; with
several it lists them and exits 2; with none it falls back to the legacy
project-level files. Prints `## FYI (autonomous decisions)` and
`## ⚠️ Action needed` (everything with `"escalate": true`), plus the summary.

## Disable the plugin

Any of:

- delete `lib/unattended.js`;
- set `UNATTENDED_DISABLE=1`;
- send `/unattended-off` in the session.

Optional env: `UNATTENDED_DEBUG=1`, `UNATTENDED_MAX_NUDGES` (default 25),
`UNATTENDED_NUDGE_MIN_MS` (default 3000).

## Acceptance tests

```bash
npm test
node skills/unattended/scripts/unattended-selftest.mjs
```

## Deliberate deviations from the original brief

1. The brief was written for the **V1** plugin API. This targets **V2**
   (`export default { id, setup(ctx) }`; `ctx.session.hook`, `ctx.event.subscribe`,
   `ctx.session.prompt`, `ctx.storage`). V1 plugin functions do not run in V2.
2. `session.compacted` / `session.idle` are **event-bus events**, not hooks, so
   they are handled in `ctx.event.subscribe()`.
3. State is **per session** (`ctx.storage` keyed by session ID, file fallback),
   not a project-wide sentinel.
4. `/unattended-off` is an in-place handover that writes an unattended-only
   summary, instead of an end-of-run close-out.
5. No notification channel and no systemd timer yet (user decision): the digest
   prints to stdout and `notify()` is a documented no-op with an ntfy example.
6. Idle nudges are debounced + capped per session.

## Notification / systemd (future)

To push the digest, implement `notify()` in
`skills/unattended/scripts/unattended-digest.sh` (ntfy example included). A user
systemd timer at ~07:00 is intentionally not installed until a channel exists; a
commented template belongs here once chosen.
