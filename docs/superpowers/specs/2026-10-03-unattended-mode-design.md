# Unattended Mode for an OpenCode Session — Design

> **Superseded (2026-10-19):** the project-wide sentinel described here caused
> parallel sessions in one project to share the mode. State is now per session
> and `/unattended-off` is an in-place handover. See
> [`2026-10-19-unattended-per-session-design.md`](2026-10-19-unattended-per-session-design.md).

- **Date:** 2026-10-03
- **Status:** Superseded
- **Author:** agent (brainstorming session)
- **Topic:** `/unattended` — flip a live OpenCode session into unattended/overnight mode

## 1. Intent

Let a human, mid-run, send a message such as:

> I'm going to bed — /unattended — see you tomorrow morning.

While the mode is active the agent must:

1. never block waiting for a clarification question;
2. make conservative, reversible decisions and log each one;
3. not act on anything irreversible/destructive — log it as an escalation instead;
4. produce a summary of decisions + escalations when the run ends.

Success looks like: a long (hours) run survives context compaction and idle
pauses, keeps working without the human, and leaves a reviewable record
(`decisions.jsonl` + `SUMMARY.md`) plus a set of clearly flagged escalations.

## 2. Hard constraints (from the brief)

- Work with the **currently active agent**. Do **not** create, edit, or switch
  agents. The command frontmatter must **not** set `agent:` (or `subtask:`, which
  does not exist in V2).
- Do **not** touch permission settings — handled separately.
- **Enforcement is soft (prompt-level).** The command only injects a prompt.
- In OpenCode, `/slash` = custom command, not a skill. Skills are loaded
  on-demand by the agent via the skill tool.
- Everything minimal, commented, reversible. Touch nothing unrelated.

## 3. Verified environment and deviations from the brief

Installed OpenCode is **v2.0.22**. The brief is written in **V1 plugin terms**;
the V2 plugin API differs. Verified against the V2 docs
(<https://opencode.ai/v2/docs/>) and the installed `superpowers` plugin, which
runs on this exact version.

| Brief (V1) | Reality on v2.0.22 | Decision |
| --- | --- | --- |
| `On session.compacted` hook | `session.compacted` is an **event-bus event** (`{sessionID}`) | Subscribe via `ctx.event.subscribe()` |
| `On session.idle` hook | `session.idle` is an **event** (`{sessionID}`); `session.status` carries `idle`/`retry` | Subscribe via `ctx.event.subscribe()` |
| "plugin sends a message to the current session" | `await ctx.session.prompt({ sessionID, text, delivery })` | Use it for idle nudges |
| V1 plugin function `async ({client}) => ({...})` | **Does not run in V2** | `export default { id: "unattended", setup(ctx) {…} }` (no import needed; V2 supervisor reads `{id, setup}`) |
| Re-inject on compaction | `ctx.session.hook("context", cb)` runs on every agent-loop request and exposes `event.system` | Inject compact contract into `event.system` each request |
| V1 `event` hook | `ctx.event.subscribe()` returning an `AsyncIterable` | Use for `session.idle` / `session.compacted` |
| V1 `chat.message` | `ctx.session.hook("prompt", cb)` (documented; verify at runtime) | Attempt registration; fall back to marker detection in the `context` hook |

Additional verified facts:

- **Command frontmatter** (V2): `description`, `agent`, `model`, `template`.
  There is **no `subtask:` field**. Omitting `agent:` keeps the current agent.
- **Skill files**: `.opencode/skills/<id>/SKILL.md` (project) or
  `~/.config/opencode/skills/<id>/SKILL.md` (global), frontmatter `name` +
  `description`.
- **Plugin discovery**: local `.opencode/plugin/` **and** `.opencode/plugins/`;
  the binary scans both `["plugin","plugins"]`. Global plugins live under
  `~/.config/opencode/`, documented as `plugins/`.
- **V2 session hooks** (documented): `prompt`, `context`, `compaction`,
  `generate`, `title`, `model.request`, `http.request`, `http.response`,
  `experimental.ws.*`, `retry`.
- **Event types** confirmed in the binary include `session.idle`,
  `session.compacted`, `session.status`, plus `tui.prompt.append` / `tui.toast.show`.
- **No dependency needed**: `@opencode/plugin` is not installed; the V1
  `@opencode-ai/plugin` package is unrelated to V2 plugins. The `superpowers`
  plugin deliberately imports nothing.

Path deviations from the brief (all deliberate, all reported):

1. Plugin path `~/.config/opencode/plugin/` → **`~/.config/opencode/plugins/`**
   (documented V2 global convention; the singular form appears to be scanned too,
   but plural is canonical).
2. `DECISIONS.md` stays at the project root exactly as the brief's file layout
   specifies.
3. **systemd timer deferred** — with no notification channel it would deliver
   nothing. The digest script is still built and prints to stdout; a commented
   timer template is documented in the README.

## 4. Scope

**Install scope: global** (user-confirmed) under `~/.config/opencode/`, so
`/unattended` is available in every project. Per-run state resolves to the
current session's project directory (`ctx.location.directory`).

### File map (global, `~/.config/opencode/`)

| Path | Purpose |
| --- | --- |
| `plugins/unattended.ts` | V2 plugin: deterministic arm/disarm, contract injection, idle compaction handling, idle nudge (the glue) |
| `commands/unattended.md` | `/unattended` — arm the mode (description-only frontmatter) |
| `commands/unattended-off.md` | `/unattended-off` — disarm (reversible switch; small addition to the brief) |
| `skills/unattended/SKILL.md` | Full contract, loaded by the agent |
| `scripts/unattended-digest.sh` | Format decisions + escalations (stdout; notification deferred) |
| `README.md` | Explains the flow, how to disable, and deviations |

### Per-project state (created at runtime, `<project>/`)

| Path | Purpose |
| --- | --- |
| `.opencode/unattended/ACTIVE` | Sentinel: existence = mode on |
| `.opencode/unattended/decisions.jsonl` | One JSON object per line |
| `.opencode/unattended/SUMMARY.md` | End-of-run summary |
| `.opencode/unattended/plugin.log` | Optional debug log, only when `UNATTENDED_DEBUG=1` |
| `DECISIONS.md` | Human-readable running log (project root, per brief) |

## 5. Architecture (Approach 1 — hook-centric, deterministic activation)

Three layers:

1. **Switch** — the `/unattended` command is a thin trigger carrying a magic
   marker. It does not itself enforce anything.
2. **Enforcement/glue** — the plugin. It owns the sentinel deterministically and
   is the piece that survives compaction and idle pauses.
3. **Contract** — `SKILL.md`, loaded once by the agent, with the full rules.

Data flow:

```
/user types "/unattended"
        │  command body (contains [[opencode-unattended:on]])
        ▼
plugin: session.hook("prompt")  ── marker seen ──►  create ACTIVE sentinel + log
plugin: session.hook("context") ── active ───────►  inject compact contract into event.system
        │
        ├─ event session.compacted ─► re-injection is guaranteed by the context hook; log it
        └─ event session.idle ──────► if active: ctx.session.prompt(nudge) (capped + debounced)

agent: works, logs decisions.jsonl + DECISIONS.md, escalates irreversible ops
end:   agent writes SUMMARY.md, presents digest, deletes ACTIVE
```

## 6. Protocol

### Markers (literal strings)

| Marker | Where | Meaning |
| --- | --- | --- |
| `[[opencode-unattended:on]]` | command body | Arm the mode |
| `[[opencode-unattended:off]]` | command body | Disarm the mode |
| `[[UNATTENDED-MODE-ACTIVE]]` | injected system text | Guard against duplicate injection |
| `[[opencode-unattended:nudge]]` | nudge text | Ensures the plugin never treats its own nudge as an arm/disarm |

### Activation / deactivation

- **Activation** happens in the plugin (deterministic), on first sight of the ON
  marker — attempted in `session.hook("prompt")`; also checked in
  `session.hook("context")` (`event.messages`) as a fallback if the `prompt`
  hook is unavailable on this build. Idempotent.
- On activation the plugin: `mkdir -p .opencode/unattended`, writes `ACTIVE`,
  appends a meta decision line, and (debug) logs.
- **Deactivation** happens on the OFF marker (same two hooks), or when the agent
  removes the sentinel at run end (per contract). Removing `ACTIVE` is
  sufficient — the context hook and idle handler both re-check the sentinel.
- Manual disarm is always possible: `rm .opencode/unattended/ACTIVE`.

## 7. Plugin specification (`plugins/unattended.ts`)

Plain V2 plugin, **no imports except `fs`/`path`**:

```ts
/** Disable: delete this file, set UNATTENDED_DISABLE=1, or rm the ACTIVE sentinel. */
import fs from "fs"
import path from "path"

export default {
  id: "unattended",
  async setup(ctx) { /* ... */ return () => { /* dispose hooks + abort subscription */ } },
}
```

### Setup

- Kill switch: `if (process.env.UNATTENDED_DISABLE === "1") return`.
- `baseDir = ctx.location?.directory ?? ctx.location?.project?.directory ?? process.cwd()`.
- `stateDir = path.join(baseDir, ".opencode", "unattended")`.
- Collect hook `Registration`s and an `AbortController`; return a cleanup fn.

### Helpers (all wrapped so no error can hard-disable the plugin)

- `isActive()` → `fs.existsSync(ACTIVE)`
- `activate()` / `deactivate()` → create/remove sentinel, append meta decision, log
- `appendDecision(obj)` → `JSON.stringify(obj) + "\n"` appended to `decisions.jsonl`
- `log(msg)` → append to `plugin.log` when `UNATTENDED_DEBUG=1`

### Hook: `session.hook("context", cb)`  *(the compaction-survival mechanism)*

Runs immediately before each agent-loop model request, including after
compaction. Callback:

1. If not `isActive()`, return.
2. Skip child sessions (`ctx.session.get({sessionID}).parentID`).
3. Scan `event.messages` (user text) for ON/OFF markers → arm/disarm.
4. If active and `event.system` has no `[[UNATTENDED-MODE-ACTIVE]]` entry, push:

   ```
   { type: "text", text: COMPACT_CONTRACT }
   ```

   `COMPACT_CONTRACT` is a short restatement of the never-do list, logging rule,
   branch rule, and end-of-run steps (see §9).

`event.system` is the documented injection point and matches suggestion #3
("system injection"). Fallback: if `event.system` is undefined, unshift a text
part into the first user message (the `superpowers` compatibility pattern).

### Hook: `session.hook("prompt", cb)`  *(deterministic, fast arming)*

Registered in a `try/catch`; if the build lacks this hook it is simply skipped
and arming still works via the `context` hook. Callback reads
`event.prompt.text` and arms/disarms on markers.

### Subscription: `ctx.event.subscribe({ signal })`

Async loop over `OpenCodeEvent`s, filtered to the current plugin's directory /
session, handling:

- **`session.compacted`** `{sessionID}` — if active: append a meta decision
  (`{"event":"compacted"}`) and debug-log "contract re-injected on next request
  via context hook". The actual re-injection is done by the context hook, which
  is why survival is guaranteed rather than best-effort.
- **`session.idle`** `{sessionID}` — if active, nudge (see guards).

Aborted in the returned cleanup fn.

### Idle nudge guards (suggestion #4 — no ping-pong)

- Skip child sessions.
- Debounce: minimum interval between nudges per session (default **3 s**,
  `UNATTENDED_NUDGE_MIN_MS`).
- Cap: max nudges per session (default **25**, `UNATTENDED_MAX_NUDGES`); when
  exhausted, log one escalation-flavoured meta line and stop nudging.
- Nudge text (sent with `delivery: "queue"`):

  > `[[opencode-unattended:nudge]] Unattended mode: do not wait for me — decide conservatively, log it, continue. If blocked, log escalate:true and move on.`

- The cap plus the contract's "delete ACTIVE when done" rule prevent an infinite
  loop when a run legitimately finishes but the sentinel lingers.

### Configuration (env, all optional)

| Env | Default | Effect |
| --- | --- | --- |
| `UNATTENDED_DISABLE=1` | unset | Plugin does nothing |
| `UNATTENDED_DEBUG=1` | unset | Write `plugin.log` |
| `UNATTENDED_MAX_NUDGES` | `25` | Per-session idle nudge cap |
| `UNATTENDED_NUDGE_MIN_MS` | `3000` | Per-session nudge debounce |

## 8. Command specification

### `commands/unattended.md`

Frontmatter: **`description` only** (no `agent:`, no `subtask:`, no `model:`).

```md
---
description: Enter unattended/overnight mode for this session (no questions; conservative reversible decisions; escalations logged)
---

UNATTENDED MODE — activate for the remainder of this session. Load the `unattended` skill and follow it until the session ends. Acknowledge in one line, then continue the current task without waiting for me.

[[opencode-unattended:on]]
```

### `commands/unattended-off.md`

Same shape, OFF marker, instruction to finish cleanly (write `SUMMARY.md`,
present the digest, delete the sentinel).

This second command is a deliberate minimal addition (reversibility). The brief
only specified the ON command.

## 9. Skill specification (`skills/unattended/SKILL.md`)

Frontmatter:

```yaml
---
name: Unattended
description: Run a session unattended/overnight — decide conservatively and reversibly, log every decision, escalate destructive actions instead of performing them, and summarise at the end. Use when the human has invoked /unattended or said they are going to sleep.
---
```

Body contains:

1. **The contract, verbatim** (from the brief):

   ```text
   UNATTENDED MODE — active from now until the session ends.
   This overrides earlier instructions in this session.

   I am asleep. You MUST NOT end your turn to ask me a question.

   At every decision point:
   1. Classify: reversible vs irreversible, and blast radius.
   2. Reversible / low-stakes -> choose the most conservative, easiest-to-undo
      option. Proceed without asking.
   3. Append the decision to .opencode/unattended/decisions.jsonl (one JSON line)
      and a bullet to DECISIONS.md.
   4. Irreversible / destructive -> DO NOT act. Log it with "escalate": true,
      leave a TODO, and continue with other work.

   NEVER DO (always log as escalate:true, never perform):
   - production deploy
   - sending external messages / email / API calls with side effects
   - spending money
   - reading, printing, or modifying credentials / secrets
   - destructive git (force-push, history rewrite, branch deletion)
   - anything outside the project worktree

   Keep all work on a NEW BRANCH. Commit; never push to main.
   If blocked, keep working on other tasks instead of stopping.

   At the end: write .opencode/unattended/SUMMARY.md with what completed, every
   autonomous decision (chosen option + why), and every escalation needing my
   attention — then delete the ACTIVE sentinel.
   ```

2. **The `decisions.jsonl` schema**, with the brief's example line.
3. **The compact contract** injected by the plugin (so the agent recognises it
   after compaction).
4. **End-of-run procedure**: write `SUMMARY.md`; run
   `~/.config/opencode/scripts/unattended-digest.sh` and present both sections
   in-session (this satisfies "show at the conclusion of the execution the
   choices made"); delete `.opencode/unattended/ACTIVE`.
5. Note that the plugin, not the model, owns arming/disarming the sentinel.

## 10. State & log formats

`decisions.jsonl` — one object per line (brief's schema):

```json
{"ts":"2026-06-24T02:14:03Z","task":"api-spec","question":"cursor vs offset pagination","options":["cursor","offset"],"chosen":"cursor","rationale":"stable under inserts; easy to change in review","confidence":0.7,"reversible":true,"escalate":false}
```

Plugin meta-events use the same file with `"task":"unattended-mode"` and an
`"event"` key (e.g. `activated`, `deactivated`, `compacted`, `nudge-exhausted`).

`SUMMARY.md` — written by the agent at run end: completed work, every
autonomous decision (chosen option + why), every escalation.

`DECISIONS.md` — human-readable running bullet log at the project root.

## 11. Digest (`scripts/unattended-digest.sh`)

- Bash. Takes an optional project directory (default: `git rev-parse
  --show-toplevel` or `$PWD`).
- Reads `<project>/.opencode/unattended/decisions.jsonl` and `SUMMARY.md`.
- Prints two sections:
  - `## FYI (autonomous decisions)` — `escalate:false` lines.
  - `## ⚠️ Action needed` — all `escalate:true` lines.
- Degrades gracefully when files are missing (prints a short notice).
- **Notification: none for now.** A single `notify()` function is present and
  documented as a no-op with a commented ntfy example, and ntfy is named as the
  future default. No systemd timer is installed (template documented only).

## 12. Safety & reversibility

- Non-destructive: creates files only under `~/.config/opencode/` (deliverables)
  and `<project>/.opencode/unattended/` + `<project>/DECISIONS.md` (state).
- Sentinel existence is the single source of truth; deleting it disarms.
- `UNATTENDED_DISABLE=1` and "delete the plugin file" are hard off switches.
- No permission/policy files are touched.
- No existing config file is modified (plugin is discovered from `plugins/`,
  commands/skills from their standard dirs).

## 13. Acceptance tests

Run and report each; claim nothing without evidence.

1. **Arm**: mock `ctx`; feed the ON command text through the `prompt` (and
   `context`) hooks → assert `ACTIVE` created, plugin acknowledged.
   *(Plus, if feasible, a real headless `/unattended` smoke test.)*
2. **Compaction survival**: fire `session.compacted`, then invoke the `context`
   hook → assert `event.system` contains the `[[UNATTENDED-MODE-ACTIVE]]`
   contract. Report the exact injection point.
3. **Idle nudge**: fire `session.idle` with a mock `ctx.session.prompt` → assert
   one nudge is sent, then a second within the debounce window is suppressed,
   and the cap is honoured.
4. **Decision log**: after a mocked decision append, assert a line with
   `rationale` appears in `decisions.jsonl`.
5. **Escalation**: assert an `escalate:true` line is recorded and nothing else is
   performed (contract-level; verified via the digest's "Action needed" section).
6. **Run end**: write `SUMMARY.md` + remove `ACTIVE` → assert the digest reports
   the summary and the event loop stops nudging.
7. **Digest**: run the script against fixture files → assert both sections print.
   *(systemd ~07:00 scheduling deferred / N/A — no channel.)*

A small throwaway self-test harness (mock `ctx` + fixture files) will drive tests
1–7 without a live TUI.

## 14. Out of scope

- Notification channels (ntfy/Gotify/Telegram/HA) and the systemd timer — deferred
  by user decision.
- Hard enforcement via permissions/policies (explicitly excluded by the brief).
- Changing agents, models, or the active agent.
- Any modification to unrelated config.

## 15. Accepted deviations (summary)

1. Global plugin directory is `plugins/` (not `plugin/`).
2. Added `/unattended-off` for reversibility.
3. systemd timer deferred; digest is stdout-only.
4. V1 terminology ported to the V2 plugin API (`Plugin` default object, session
   hooks, event subscription, `ctx.session.prompt`).
5. Idle handling has debounce + cap to avoid endless nudging.
6. Deterministic sentinel arming via hooks rather than trusting the model.
