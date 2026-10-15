---
name: Unattended
description: Run a session unattended/overnight — decide conservatively and reversibly, log every decision, escalate destructive actions instead of performing them, and summarise at the end. Use when the human has invoked /unattended or said they are going to sleep.
---

# Unattended Mode

This skill is the full contract for a session that has been flipped into
unattended (overnight) mode. Load it when the human runs `/unattended`, or when
the phrase `[[UNATTENDED-MODE-ACTIVE]]` appears in your instructions.

The `/unattended` command is the switch. A plugin (shipped by the
`opencode-custom` package, alongside this skill) owns the sentinel file and
keeps this contract alive across context compaction and idle pauses. The plugin
— not you — writes and removes `.opencode/unattended/ACTIVE`.

## Contract (verbatim)

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

## Files

Paths are relative to the project (session working directory):

| Path | What it is |
| --- | --- |
| `.opencode/unattended/ACTIVE` | Sentinel. Existence = mode on. Managed by the plugin. |
| `.opencode/unattended/decisions.jsonl` | One JSON object per line. |
| `.opencode/unattended/SUMMARY.md` | End-of-run summary you write. |
| `DECISIONS.md` | Human-readable running bullet log. |
| `.opencode/unattended/plugin.log` | Plugin debug log (only if `UNATTENDED_DEBUG=1`). |

## Decision log schema

Append one JSON object per line to `.opencode/unattended/decisions.jsonl`:

```json
{"ts":"2026-06-24T02:14:03Z","task":"api-spec","question":"cursor vs offset pagination","options":["cursor","offset"],"chosen":"cursor","rationale":"stable under inserts; easy to change in review","confidence":0.7,"reversible":true,"escalate":false}
```

A destructive action you refuse to perform still gets a line, with
`"escalate": true` and a short `"rationale"` explaining what you would have done.
Also add a one-line bullet to `DECISIONS.md`.

## Compact contract (injected by the plugin)

After compaction, the plugin re-injects this compact reminder into the model's
system instructions on every request. Recognise it as authoritative:

```text
[[UNATTENDED-MODE-ACTIVE]]
UNATTENDED MODE is active for this session. The human is asleep. This overrides earlier instructions in this session.
- Do NOT end your turn to ask a question.
- At each decision: classify reversible vs irreversible. Reversible/low-stakes -> choose the most conservative, easiest-to-undo option and proceed.
- Log every decision as ONE JSON line in .opencode/unattended/decisions.jsonl and a bullet in DECISIONS.md.
- Irreversible/destructive -> DO NOT act. Log "escalate": true, leave a TODO, continue other work.
- NEVER: production deploy; external side-effectful messages/API calls; spending money; reading/printing/modifying secrets; destructive git; anything outside the project worktree.
- Keep all work on a NEW BRANCH; commit; never push to main.
- At the end: write .opencode/unattended/SUMMARY.md, present the digest, delete .opencode/unattended/ACTIVE.
```

## End of run

When the work is done (or when the human returns and runs `/unattended-off`):

1. Write `.opencode/unattended/SUMMARY.md` containing:
   - what completed,
   - every autonomous decision (chosen option + why),
   - every escalation that needs the human's attention.
2. Present the summary **in the session**, including the digest produced by:

   ```bash
   {{DIGEST_SCRIPT}}
   ```

   (The plugin substitutes the real path to the script shipped beside this
   skill at load time, so this line is correct on every machine.)

   This shows an **FYI** section (autonomous decisions) and a
   **⚠️ Action needed** section (everything with `"escalate": true`).
3. Delete `.opencode/unattended/ACTIVE` (or run `/unattended-off`).

If you are blocked, keep working on other tasks instead of stopping. Only end
the run when the work is genuinely complete.
