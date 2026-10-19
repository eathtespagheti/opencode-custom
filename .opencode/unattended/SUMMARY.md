# Unattended run — 2026-10-19

Task: improve the GitLab board/kanban/issue skills; answer "what else is on
GitLab Free besides milestones?"

Branch: `feat/gitlab-planning-skills` (created from `feat/unattended-per-session`)
Commit: `1df2e5b` — `docs(gitlab-issue-board): cover the Free-tier planning toolkit`

## What completed

- Researched the GitLab docs for every planning feature and recorded its tier
  (Free / Premium / Ultimate) instead of guessing:
  issue boards, milestones, labels, quick actions, due dates, time tracking,
  cross-linking, confidentiality, CSV export/import, To-Do List, service desk,
  releases, weight, health status, custom status, iterations, epics/roadmap,
  saved views/workplan.
- Extended `skills/gitlab-issue-board/SKILL.md` (+117 lines) with:
  - a **tier table** at a glance,
  - **milestones** as the Free timeboxing backbone (create / close / assign,
    burndown & burnup),
  - a **quick-actions** table (`/board_move`, `/relate`, `/blocked_by`,
    `/blocks`, `/unlink`, `/due`, `/estimate`, `/spend`, `/milestone`,
    `/todo`, `/label`, `/confidential`, `/duplicate`, …),
  - metadata the board does not show (due dates, time tracking, dependencies,
    confidentiality, To-Do List, CSV import/export),
  - an explicit "what you cannot do on Free" list,
  - a **tier-check recipe** (`projects/:id` → `namespace.id` → `namespaces/<id>.plan`).
- Widened the skill `description` so it triggers on milestones / triage /
  planning work, not just board moves.
- Updated `README.md` to describe the expanded scope.
- `npm test`: **25 passed, 0 failed**.

## Decisions

| Question | Chosen | Why |
|---|---|---|
| Skill layout | Extend `gitlab-issue-board` in place | One skill keeps discovery simple; splitting would duplicate/conflict and add trigger overlap |
| Feature scope | Document every verified Free feature | The user asked "what else is available"; each tier was checked in the docs |
| Ambiguous tiers (weight, multiple assignees, linked issues, health status, status, iterations, epics, saved views) | Mark as paid / ⚠️ verify-first, plus a tier-check recipe | Avoid teaching the agent to call paid-only APIs and fail mid-run on Free |
| README | Update | It documents what the plugin registers; stale docs mislead |
| Releases | Free basic; group release metrics Ultimate | Per docs |

Escalations: **none**. Nothing destructive or outside the worktree was done;
no push, no deploy, no credentials touched.

## Answer to the original question

Beyond milestones, the Free plan also gives you: labels (plain, priorities,
colors), quick actions, due dates, time tracking (`/estimate`, `/spend`),
cross-links and blocking (`/relate`, `/blocked_by`, `/blocks`), confidential
issues, CSV export/import, the To-Do List, Service Desk, basic releases, and
multiple project boards (only **one group board**). Not on Free: scoped labels,
epics, iterations, roadmap, health status, custom status workflow, configurable
boards / assignee / milestone lists.

## Follow-ups (not done)

- Confirm on a real Free project whether **weight** and **multiple assignees**
  are accepted by the API; if so, promote them from ⚠️ to ✅.
- The `gitlab-issue-board` skill still has a small duplicated tail in
  "Gotchas" (pre-existing); worth a tidy pass.