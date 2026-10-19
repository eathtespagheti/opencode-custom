# Unattended mode: per-session state and an in-place off toggle

**Date:** 2026-10-19
**Status:** design, awaiting approval
**Supersedes:** the project-wide sentinel in
`docs/superpowers/specs/2026-10-03-unattended-mode-design.md`

## Why

`<project>/.opencode/unattended/ACTIVE` is one flag for the whole project. Every
session whose working directory is that project reads it, so starting an
unattended session silently flips every other session in the same project into
unattended mode as well: they stop asking questions, write into the same
decision log, and queue "keep going" nudges.

That is what happened during a parallel run: an unrelated session picked up the
flag and started behaving as if the human were asleep. `/unattended-off` has the
same problem in reverse — removing the shared file disarms every session.

The state has to belong to one session.

## Goals

- Unattended state is scoped to a single session. Two sessions in one project
  never share it.
- `/unattended-off` sent mid-session immediately returns *that session* to
  normal behaviour without stopping or re-planning the running task.
- Turning off produces a review artifact straight away: a summary of the
  decisions made **while unattended only**.
- No writes to project-wide files that another session also writes.

## Non-goals

- No change to what unattended mode allows or forbids (the never-do list).
- No `/unattended-status` command (a reasonable later addition).
- No automatic restart or re-plan of the task when the mode changes.
- No aggregation of several sessions into one summary.

## Decisions already taken with the human

| Question | Decision |
| --- | --- |
| Where does the flag live? | Session-scoped record in the plugin's durable storage (`ctx.storage`), keyed by session ID. Per-session file fallback. |
| What does "off" mean? | Disarm this session now; keep the current task running; ask questions and wait again from then on. |
| When is the summary written? | Immediately, on the turn that turns the mode off. |
| What does the summary cover? | Only decisions made while unattended. Work before or after the mode is out of scope. |
| Is `/unattended-off` a new command? | No. It exists; its meaning is repurposed (today it writes an end-of-run summary and removes the shared flag). |

## State model

One record per session, stored under the key
`unattended/session/<sessionID>` in `ctx.storage`:

```json
{
  "sessionID": "ses_abc123",
  "armed": true,
  "armedAt": "2026-10-19T10:00:00.000Z",
  "disarmedAt": null,
  "baseDir": "/home/me/project",
  "reason": "prompt-hook"
}
```

Why `ctx.storage`:

- It is the documented V2 plugin store for durable JSON values, scoped to the
  plugin.
- The key is a session ID, so it cannot leak between sessions.
- It follows a session that is moved to another directory (`session.move`).
- It does not require writing state files into the user's project.

Backend selection is decided **once** at setup, not per write:

- If `ctx.storage` exists and its hydrate `scan` succeeds, storage is the
  backend for the life of the process. A later `set` failure is logged and the
  in-memory map still applies; it does not switch to files mid-run (that would
  leave two divergent records).
- If `ctx.storage` is missing or the hydrate scan throws, the per-session file
  backend is used for the whole process:
  `<baseDir>/.opencode/unattended/sessions/<sessionID>/ACTIVE`
  (existence means armed) plus `record.json` for `armedAt`, `disarmedAt`, and
  `pendingNotice`. Neither backend ever reads or writes the project-wide
  `.opencode/unattended/ACTIVE`.
- `UNATTENDED_DISABLE=1` remains a hard off switch.

Implementation shape:

- `setup()` hydrates an in-memory `Map<sessionID, record>` with one
  `storage.scan({ prefix: "unattended/session/" })` call.
- Reads (`isActive(sessionID)`) are served from the map. Writes update the map
  first and then persist via the chosen backend.

Session identity rules:

- Every hook and event resolves its own `event.sessionID`. An event without a
  session ID is ignored and logged; the plugin fails closed.
- Child/subagent sessions stay excluded, as today.
- `baseDirFor(sessionID)` still exists, but only to locate artifacts. It is no
  longer used to decide whether the mode is on.

### Legacy flag

A pre-existing `<project>/.opencode/unattended/ACTIVE` is ambiguous: it cannot
be attributed to a session. The plugin therefore ignores it (reads nothing,
deletes nothing, arms nobody) and logs that it found it. The docs and README
say it can be removed by hand.

## Markers and ordering

The ON/OFF markers are unchanged:

```
[[opencode-unattended:on]]
[[opencode-unattended:off]]
```

Marker sources are strict, so injected text can never flip the mode:

- **Prompt hook** (`event.prompt.text`): the authoritative source for human
  ON/OFF. Only genuine submitted prompts reach it.
- **Context-hook fallback**: used only when the prompt hook is unavailable on
  this build (tracked at setup), or when the session has no stored record yet
  (bootstrap). In the bootstrap case, scan user-role messages in order and let
  the **last marker win**, so a history of ON … OFF resolves to off. Once a
  record exists, history is not scanned again.
- **Assistant end marker**: never read from hooks. At idle, the plugin fetches
  the last assistant message and treats a trailing `[[opencode-unattended:off]]`
  as "the run finished on its own" (see end of run).
- **Ignored**: system parts, tool results, plugin-injected contract blocks, and
  any part carrying the `[[UNATTENDED-MODE-ACTIVE]]` guard. Skill bodies are
  read as tool results, so the literal end marker documented in `SKILL.md`
  cannot disarm a session.

The stored record is authoritative once it exists. A stale ON in the transcript
can never re-arm a session the human explicitly turned off.

## Turning off mid-session

Sequence:

1. The human sends `/unattended-off` as steering while a task is running.
2. The prompt hook sees the OFF marker. It sets `armed: false`, records
   `disarmedAt`, clears the nudge counters for that session, and sets an
   in-memory `offNoticePending` flag.
3. On the next model request, the context hook injects a one-shot **off notice**
   into `event.system` instead of the usual contract. The notice contains
   absolute paths and says, in substance:
   - unattended mode is off **for this session**; do not stop or re-plan the
     running task;
   - before continuing, write a summary to `<sessionDir>/SUMMARY.md` covering
     only decisions made in **this** unattended run: read
     `<sessionDir>/decisions.jsonl`, keep rows with `ts >= armedAt`, exclude the
     mode on/off meta events, include the chosen option and rationale for each,
     and list every escalation;
   - present that summary in the reply;
   - then continue the current task; from now on ask questions and wait for the
     human like a normal session.
4. The notice is injected once and not repeated. `pendingNotice` is persisted in
   the session record, so a plugin reload between the off and the next request
   still delivers it. It is cleared with a `storage.set` immediately after the
   request that carries it. Subsequent requests get neither the contract nor the
   notice.

Summary window across several arm cycles: each off summarises the interval
starting at the record's current `armedAt`. `SUMMARY.md` is overwritten by the
next off (header records the interval); the full decision log is append-only, so
nothing is lost. A run that ends by itself writes its summary before emitting the
end marker, exactly as today.

A nudge queue entry created just before the off may still surface as the next
user message. The off notice is injected into that same request and takes
precedence, so the handover still happens on the first request after off. No new
nudges are created once the record is unarmed.

If the prompt hook is unavailable, the context hook detects the user OFF marker
in the newest user message and injects the notice in that same request.

Why a plugin-injected notice rather than relying on the command text alone: the
command may be queued, compacted away, or followed by a long tool loop. The
notice is produced by the same deterministic path that disarms the session, and
it carries the session's real paths, so the handover does not depend on the
model remembering the command wording.

## End of run (natural completion)

When the agent believes the unattended run is complete it writes
`<sessionDir>/SUMMARY.md` and ends its final message with the literal marker
`[[opencode-unattended:off]]`. On `session.idle`, if the session is still armed,
the plugin fetches `ctx.session.context({ sessionID })`, scans the last
assistant message for the marker, and disarms silently (no off notice, no
summary prompt). This replaces today's "delete ACTIVE" instruction, which the
agent cannot do to plugin storage. The idle-nudge cap is unchanged and still
acts as the backstop if the agent never emits the marker.

## Artifacts: one directory per session

```
<project>/.opencode/unattended/
├── ACTIVE                     # legacy project-wide flag, ignored
├── decisions.jsonl            # legacy, no longer read or written
├── plugin.log                 # legacy, ignored
└── sessions/
    └── <sessionID>/
        ├── decisions.jsonl    # mode meta events + task decisions
        ├── SUMMARY.md         # written by the agent at off / run end
        ├── DECISIONS.md       # human-readable bullet log for this session
        └── plugin.log         # only when UNATTENDED_DEBUG=1
```

- Session IDs are sanitized for path use (`[^A-Za-z0-9._-]` → `_`). IDs already
  look like `ses_…`, so collisions are not a practical concern.
- **Location after `session.move`**: artifacts live under the session's
  *current* directory at the time of the write (`baseDirFor(sessionID)` is
  resolved fresh on each arm). The record stores `baseDir` as a hint only, so
  the summary lands where the session is now. Old artifacts are not migrated;
  the digest can be pointed at the old directory.
- The root `DECISIONS.md` is no longer written. The per-session file replaces it.
- The injected contract now includes the session's absolute
  `decisions.jsonl`, `DECISIONS.md`, and `SUMMARY.md` paths, so the model never
  has to infer them.

## Contract and nudges

- `COMPACT_CONTRACT` becomes a function of the session paths. Its rules are
  otherwise unchanged (decide conservatively, log, escalate destructive work,
  branch, never push to main, end-of-run summary). The header of the injected
  contract names the session ID, and every artifact path is absolute, so the
  agent never has to guess which session it is writing for and never needs to
  read `ctx.storage` itself.
- Nudge counters and debounce stay per-session in memory; they are now also
  cleared on off. An idle event for an unarmed or unknown session does nothing.

## Command changes

`/unattended` keeps its current intent and marker.

`/unattended-off` becomes a steering handover:

```markdown
---
description: Leave unattended mode for this session (keep the running task; write an unattended-only summary)
---

UNATTENDED MODE OFF for this session. Do not stop or re-plan the current task:
keep working on it in normal mode. Follow the off notice the plugin adds to
your instructions — write the unattended-only summary where it says, present
it, then continue and ask questions again when you need to.

[[opencode-unattended:off]]
```

## Digest script

`skills/unattended/scripts/unattended-digest.sh`:

- Usage: `unattended-digest.sh [--session <id>] [project-dir]`.
- If `--session` is given, read that session directory.
- If a project directory is given and it contains exactly one session
  directory, use it; if it contains several, list them and exit non-zero; if it
  contains none, fall back to the legacy project-level files so old runs remain
  readable.
- `notify()` stays a documented no-op.

## Files to change

| File | Change |
| --- | --- |
| `lib/unattended.js` | session-scoped store, hydration, off notice, idle scan, per-session paths, contract builder |
| `commands/unattended-off.md` | new handover wording |
| `commands/unattended.md` | one-line clarification that the mode is per session |
| `skills/unattended/SKILL.md` | per-session paths, off semantics, end-of-run marker |
| `skills/unattended/scripts/unattended-digest.sh` | session selection |
| `skills/unattended/scripts/unattended-selftest.mjs` | storage mock + new acceptance cases |
| `test/plugin.test.mjs` | storage mock + per-session assertions |
| `docs/unattended.md`, `README.md` | document the new layout and off behaviour |

## Acceptance tests

1. **Isolation.** ON in session A (project P). A is armed; B in the same project
   is not. B's context request receives no contract.
2. **Off is local.** OFF in A disarms A only; B's record is untouched. A gets the
   off notice exactly once, and the following request gets neither contract nor
   notice.
3. **History replay.** With no stored record, a context containing ON then OFF
   ends disarmed; a later ON re-arms.
4. **Stored off wins.** An explicit off record plus stale ON history does not
   re-arm.
5. **Fallback store.** Without `ctx.storage`, A's per-session file arms only A;
   off removes only A's file.
6. **Nudges.** Armed A is nudged on idle; disarmed A is not; B never is.
7. **Children.** A child session gets no state, no contract, no nudge.
8. **Assistant end marker.** An assistant OFF marker seen at idle disarms
   silently and suppresses the nudge.
9. **Legacy flag.** A project-level ACTIVE arms nobody.
10. **Paths.** The injected contract contains this session's absolute artifact
    paths.

## Migration and rollout

- Ship as a normal package update; no config changes.
- Existing project-level `ACTIVE`, `decisions.jsonl`, and root `DECISIONS.md`
  are left untouched and become inert. The digest can still read the old pair
  when no session directories exist.
- The first `/unattended` after the upgrade creates only the session directory.

## Left to the builder

- Exact pruning policy for old session records (suggest: drop records untouched
  for 30 days during hydration).
- Whether the notice uses `event.system` or the existing first-user-message
  fallback when no system array is present.
- Final wording of the contract and notice.
- Digest presentation when several sessions exist.
