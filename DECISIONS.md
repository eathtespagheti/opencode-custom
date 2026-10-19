# Decisions (unattended mode)

- 2026-10-19T10:37:52.419Z — unattended mode ACTIVATED
- 2026-10-19T10:58:25.756163+00:00 — Where should the per-session armed state live? -> ctx.storage keyed by sessionID, with per-session file fallback (documented durable V2 plugin store; cannot leak across sessions; survives session.move; no state writes into the user's project)
- 2026-10-19T10:58:25.756163+00:00 — What should /unattended-off do? -> immediate disarm + prompt-summary of unattended decisions only (human chose option 1: keep working, ask questions again, review choices made while unattended)
- 2026-10-19T10:58:25.756163+00:00 — How does the agent disarm at natural run end, now that state is in plugin storage? -> assistant emits [[opencode-unattended:off]]; plugin scans the last assistant message at idle and disarms silently (preserves today's end-of-run behaviour without a shared mutable file; nudge cap remains the backstop)
- 2026-10-19T10:58:25.756163+00:00 — What to do with the legacy project-level ACTIVE flag? -> ignore and leave in place, log once (cannot attribute the legacy flag to a session; auto-arming recreates the bug; deleting user files is destructive)
- 2026-10-19T10:58:25.756163+00:00 — Which branch should hold the work? -> feat/unattended-per-session (unattended rules require a new branch and prohibit working on main)
