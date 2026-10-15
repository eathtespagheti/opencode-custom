# Unattended Mode for OpenCode sessions

Flip a live session into unattended/overnight mode by sending:

```
I'm going to bed — /unattended — see you tomorrow morning.
```

While active, the agent will not block on questions: it makes conservative,
reversible decisions, logs each one, refuses irreversible/destructive actions
(logging them as escalations), and writes a summary at the end.

## Files

All paths are inside the `opencode-custom` package:

| Path | Purpose |
| --- | --- |
| `lib/unattended.js` | V2 plugin — arms/disarms the sentinel, keeps the contract alive across compaction + idle (the glue) |
| `commands/unattended.md` | `/unattended` — enter the mode (registered by the plugin) |
| `commands/unattended-off.md` | `/unattended-off` — leave it and close out |
| `skills/unattended/SKILL.md` | The full contract, loaded by the agent |
| `skills/unattended/scripts/unattended-digest.sh` | Renders decisions + escalations (stdout; notification deferred) |
| `skills/unattended/scripts/unattended-selftest.mjs` | Acceptance self-test (mock ctx, no live model needed) |

Per-run state is written into the **current project**:

```
<project>/.opencode/unattended/ACTIVE           # sentinel: existence = mode on
<project>/.opencode/unattended/decisions.jsonl  # one JSON object per line
<project>/.opencode/unattended/SUMMARY.md       # end-of-run summary
<project>/.opencode/unattended/plugin.log        # only when UNATTENDED_DEBUG=1
<project>/DECISIONS.md                           # human-readable bullet log
```

## How it survives the night

The slash command is only a soft prompt. The plugin is what actually makes the
mode durable:

1. **Deterministic arming.** `session.hook("prompt")` sees the
   `[[opencode-unattended:on]]` marker and writes `ACTIVE` itself — it does not
   trust the model to create the file. (A `context`-hook fallback scans the
   message text if the `prompt` hook is unavailable.)
2. **Compaction survival.** `session.hook("context")` runs before every
   agent-loop model request and, while the sentinel exists, pushes a compact
   contract into `event.system`. Because that happens per request — including
   right after a compaction — the contract cannot be silently lost.
3. **Idle nudges.** `ctx.event.subscribe()` watches `session.idle`; if the mode
   is active the plugin queues a "do not wait for me" prompt. Nudges are
   debounced and capped so a finished run cannot ping-pong forever.
4. `session.compacted` events are logged so you can see re-injection happened.

## Use

```
/unattended            # enter unattended mode
/unattended-off        # leave it: write SUMMARY.md, show the digest, remove ACTIVE
```

Manual disarm is always available:

```bash
rm .opencode/unattended/ACTIVE
```

## Digest

```bash
scripts/unattended-digest.sh [project-dir]
```

Prints `## FYI (autonomous decisions)` and `## ⚠️ Action needed` (everything with
`"escalate": true`), plus the summary.

## Disable the plugin

Any of:

- delete `plugins/unattended.ts`;
- set `UNATTENDED_DISABLE=1`;
- remove the `ACTIVE` sentinel.

Optional env: `UNATTENDED_DEBUG=1`, `UNATTENDED_MAX_NUDGES` (default 25),
`UNATTENDED_NUDGE_MIN_MS` (default 3000).

## Acceptance tests

```bash
node scripts/unattended-selftest.mjs
```

## Deliberate deviations from the original brief

1. The brief was written for the **V1** plugin API. This targets **V2**
   (`export default { id, setup(ctx) }`; `ctx.session.hook`, `ctx.event.subscribe`,
   `ctx.session.prompt`). V1 plugin functions do not run in V2.
2. `session.compacted` / `session.idle` are **event-bus events**, not hooks, so
   they are handled in `ctx.event.subscribe()`.
3. Plugin lives in `plugins/` (documented V2 global convention), not `plugin/`.
4. Added `/unattended-off` for reversibility.
5. No notification channel and no systemd timer yet (user decision): the digest
   prints to stdout and `notify()` is a documented no-op with an ntfy example.
6. Idle nudges are debounced + capped.

## Notification / systemd (future)

To push the digest, implement `notify()` in
`scripts/unattended-digest.sh` (ntfy example included). A user systemd timer at
~07:00 is intentionally not installed until a channel exists; a commented
template belongs here once chosen.
