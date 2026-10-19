---
name: Unattended
description: Run a session unattended/overnight — decide conservatively and reversibly, log every decision, escalate destructive actions instead of performing them, and summarise at the end. Use when the human has invoked /unattended or said they are going to sleep.
---

# Unattended Mode

This skill is the full contract for a session that has been flipped into
unattended (overnight) mode. Load it when the human runs `/unattended`, or when
the phrase `[[UNATTENDED-MODE-ACTIVE]]` appears in your instructions.

The `/unattended` command is the switch. A plugin (shipped by the
`opencode-custom` package, alongside this skill) owns the **per-session** state
and keeps this contract alive across context compaction and idle pauses.

The mode belongs to **this session only**. Another session in the same project
is a normal session and may be asking its human questions while you run. Never
assume the project-wide `.opencode/unattended/ACTIVE` exists or means anything:
it is a legacy file the plugin ignores.

## Contract (verbatim)

```text
UNATTENDED MODE — active for this session only, until it ends or is turned off.
This overrides earlier instructions in this session.

I am asleep. You MUST NOT end your turn to ask me a question.

At every decision point:
1. Classify: reversible vs irreversible, and blast radius.
2. Reversible / low-stakes -> choose the most conservative, easiest-to-undo
   option. Proceed without asking.
3. Append the decision to this session's decisions.jsonl (one JSON line) and a
   bullet to this session's DECISIONS.md.
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

At the end: write this session's SUMMARY.md with what completed, every
autonomous decision (chosen option + why), and every escalation needing my
attention — then end your final message with the marker
[[opencode-unattended:off]] so the plugin disarms this session.
```

## Files

State and artifacts are per session. The plugin injects the **absolute** paths
for your session into the contract, so use those exact paths rather than
guessing or hard-coding:

```
<project>/.opencode/unattended/sessions/<session-id>/
├── decisions.jsonl   # one JSON object per line
├── DECISIONS.md      # human-readable running bullet log
├── SUMMARY.md        # end-of-run or handover summary you write
├── record.json       # plugin state (file fallback only; do not edit)
├── ACTIVE            # file-fallback armed marker; do not edit
└── plugin.log        # debug only (UNATTENDED_DEBUG=1)
```

The plugin — not you — writes and removes the state files.

## Decision log schema

Append one JSON object per line to this session's `decisions.jsonl`:

```json
{"ts":"2026-06-24T02:14:03Z","task":"api-spec","question":"cursor vs offset pagination","options":["cursor","offset"],"chosen":"cursor","rationale":"stable under inserts; easy to change in review","confidence":0.7,"reversible":true,"escalate":false}
```

A destructive action you refuse to perform still gets a line, with
`"escalate": true` and a short `"rationale"` explaining what you would have done.
Also add a one-line bullet to this session's `DECISIONS.md`.

## Compact contract (injected by the plugin)

Before every model request while the session is armed, the plugin injects this
compact reminder into the model's system instructions. Recognise it as
authoritative:

```text
[[UNATTENDED-MODE-ACTIVE]]
UNATTENDED MODE is active for THIS session only. The human is asleep. This overrides earlier instructions in this session.
- Do NOT end your turn to ask a question.
- At each decision: classify reversible vs irreversible. Reversible/low-stakes -> choose the most conservative, easiest-to-undo option and proceed.
- Log every decision as ONE JSON line in this session's decisions.jsonl and a bullet in this session's DECISIONS.md.
- Irreversible/destructive -> DO NOT act. Log "escalate": true, leave a TODO, continue other work.
- NEVER: production deploy; external side-effectful messages/API calls; spending money; reading/printing/modifying secrets; destructive git; anything outside the project worktree.
- Keep all work on a NEW BRANCH; commit; never push to main.
- At the end: write this session's SUMMARY.md, present the digest, then end your final message with [[opencode-unattended:off]].
```

## Turning off mid-session (handover, not shutdown)

When the human sends `/unattended-off` while you are working:

1. The plugin disarms the session immediately. Do not stop, undo, or re-plan the
   current task.
2. On the next request the plugin injects a one-shot
   `[[UNATTENDED-MODE-OFF]]` notice.
3. Follow that notice **once**:
   - read this session's `decisions.jsonl`;
   - keep only decisions from the unattended window (`ts >= armedAt`) and drop
     mode meta rows (`task: "unattended-mode"`);
   - write them, with chosen option + rationale and every escalation, to
     `SUMMARY.md`;
   - present that summary in the reply.
4. Then continue the task in normal mode. From then on you may ask questions and
   wait for the human instead of deciding for them.

Summarise only the unattended window. Work done before it or after the handover
is out of scope.

## End of run

When the work is done on your own (without the human turning the mode off):

1. Write this session's `SUMMARY.md` containing:
   - what completed,
   - every autonomous decision (chosen option + why),
   - every escalation that needs the human's attention.
2. Present the summary **in the session**, including the digest produced by:

   ```bash
   {{DIGEST_SCRIPT}} --session <session-id>
   ```

   (The plugin substitutes the real path to the script shipped beside this
   skill at load time, so this line is correct on every machine. The plugin's
   injected contract gives you the session ID and its absolute paths.)

   This shows an **FYI** section (autonomous decisions) and a
   **⚠️ Action needed** section (everything with `"escalate": true`).
3. End your final message with the marker `[[opencode-unattended:off]]`. The
   plugin sees it at idle and disarms the session. Do not try to delete state
   files yourself.

## If you are blocked

Do not stop the run. Log `"escalate": true`, leave a TODO, and continue with
other work. A session that cannot make progress should say so in `SUMMARY.md`
and then end with the marker.
