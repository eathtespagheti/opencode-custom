---
name: gitlab-issue-board
description: Use when tracking work as GitLab issues in a repository whose project already has an issue board configured (bootstrap already done) — creating issues, moving cards between columns, editing, commenting, closing, deleting, or adding another board. Also covers the rest of GitLab's Free-tier planning toolkit: milestones, labels and metadata, quick actions, due dates, time tracking, cross-links, confidentiality, CSV import/export, the To-Do List, and service desk. Requires a GitLab-hosted repo with `glab` installed and authenticated. Do not use for repositories with no board or no issues yet, and do not use for non-GitLab trackers.
---

# GitLab Issue Boards

## Overview

**A board column is not a container you put a card into. A column is a label, and an issue sits in that column purely because it carries that label.** Everything else follows from that one fact:

- "Move a card to *Doing*" = swap which status label the issue has.
- "The issue fell off the board" = it has no status label.
- "Make a new board" = make an empty shell, then create one label-backed list per column.

**Nothing enforces one-column-per-card.** Plain labels are not mutually exclusive, and the only built-in exclusivity mechanism — scoped labels — is a paid tier. So the invariant "an issue has exactly one status" is a convention you uphold by always swapping, never adding. The verify step at the end is the only guard there is.

`glab` has first-class support for issues, but almost none for board *layout*: only `glab issue board create` (name only) and an interactive `view`. Everything else goes through `glab api`. This skill is the map for that gap.

## When to Use

Use when all of these hold:

- The repository is hosted on GitLab and `glab` is installed and authenticated.
- **Bootstrap is already done** — the project has an issue board with columns configured, and a label scheme that matches it.
- You are creating, reading, moving, editing, commenting on, closing, or deleting issues, or you have been asked to add *another* board.

**Do not use** when the project has no board or no issues yet. There is no column scheme to move cards between and no taxonomy to reuse, so anything you do would be invented. Detect this at step 0 and stop; say the project isn't bootstrapped rather than guessing a scheme.

**Exception:** if the human *explicitly* asks you to set up / bootstrap a board for a repo, go to [Creating a board](#creating-a-board-bootstrap). That is a deliberate request, not an autonomous trigger — do not bootstrap on your own initiative.

## Step 0 — Confirm preconditions (always do this first)

```bash
glab auth status                       # authenticated?
git remote -v                          # is there a GitLab remote?
glab api "projects/:id/boards"         # must be non-empty  -> the columns
glab label list --per-page 100         # the label scheme
glab issue list -O json                # existing issues
```

If `boards` returns `[]`, or there are no labels: the project is **not bootstrapped**. Stop and report that. Do not invent labels or columns.

**Find the column scheme** from the board itself — do not assume names like "To Do". Each list has a `label.name`, and those label names *are* the statuses:

```bash
glab api "projects/:id/boards/<board_id>" \
  | python3 -c "import sys,json; [print(l['position'], (l.get('label') or {}).get('name')) for l in json.load(sys.stdin)['lists']]"
```

Status labels are exactly the labels that appear as board lists. Anything else (`type/*`, `area/*`, …) is metadata that never becomes a column.

## Quick Reference

`<iid>` is the issue number shown as `#42`; it is **not** the global issue id.

| Operation | Command |
|---|---|
| Project metadata | `glab api "projects/:id"` |
| Check plan / tier | `glab api "projects/:id"` → `namespace.id`, then `glab api "namespaces/<ns_id>"` → `.plan` |
| List issues | `glab issue list -O json` |
| View one issue | `glab issue view <iid> -F json` |
| Create issue | `glab issue create -t "T" -d "D" --label todo,type/chore -y` |
| **Move card** | `glab issue update <iid> --label <new> --unlabel <other statuses>` |
| Edit title/body | `glab issue update <iid> -t "T" -d "D"` |
| Comment | `glab issue note <iid> -m "text"` |
| Assign | `glab issue update <iid> --assignee <username>` |
| Close / reopen | `glab issue close <iid>` / `glab issue reopen <iid>` |
| Delete | `glab issue delete <iid>` |
| List board columns | `glab api "projects/:id/boards/<board_id>"` |
| Create board | `glab issue board create --name "N"` (then add lists) |
| Add a column | `glab api --method POST "projects/:id/boards/<bid>/lists" --raw-field label_id=<id>` |
| Delete board | `glab api --method DELETE "projects/:id/boards/<bid>"` |

## Moving a card between columns

There is no move command. Add the target status and remove every other status in a single call:

```bash
glab issue update 42 --label doing --unlabel todo,blocked,review,done
```

**Rule: exactly one status label at a time.** Passing all the other statuses as `--unlabel` makes the call idempotent and unsticks an issue that somehow acquired two. Take the status names from the board lists — never hardcode them, since another project's scheme will differ.

## Creating a board (bootstrap)

`glab issue board create` accepts only a name and creates a board with **zero columns**. Columns must then be added as label-backed lists, in order, over the API:

```bash
# 1. columns must already exist as labels
glab label create --name doing --color "#F0AD4E" --description "In progress"

# 2. create the empty board
glab issue board create --name "Experiments"

# 3. get the new board's id
glab api "projects/:id/boards"

# 4. map column label names -> label ids
glab api "projects/:id/labels?per_page=100"

# 5. add one list per column, left to right
glab api --method POST "projects/:id/boards/<board_id>/lists" --raw-field label_id=<label_id>
```

Order matters: **POST order is left-to-right column order**, and it cannot easily be reordered afterwards — decide the order before you start. A board with no lists renders as an empty board.

## Session workflow (autonomous)

When picking up work in a bootstrapped repo:

1. **Read the board first.** See what is already in progress and what is queued, so you don't duplicate a card or start two things at once.
2. **Claim before starting** — move the issue into the in-progress column, and leave a one-line comment if someone would otherwise wonder who has it.
3. **Park blockers loudly.** Move to the blocked column and comment *what* you are waiting on. Never let work silently stall.
4. **Move the card when you finish.** If the board has a review column, default to **review** — it is the reversible choice and the work is still unverified by anyone else. Move straight to **done** only when the work is genuinely finished *and* the board already shows that convention (for example a column named "done" whose cards are closed). When the two are genuinely ambiguous, prefer review, and say which you chose and why.
5. **Comment only when it carries information.** What changed and how you verified it is worth a comment; a purely mechanical status change is not. Don't narrate commands.
6. **Respect the convention**: in some repos `done` is a column and the issue stays open; in others the card is closed. Match what the board already does rather than inventing a rule.
7. **Never delete an issue** unless the human explicitly asked for deletion. Closing is the reversible option; deleting is not.

Report back with the issue URL so the human can click through.

## Free-tier planning toolkit (beyond the board)

Boards are the visual layer. On the **Free** plan GitLab also gives you a full lightweight planning stack — use these before reaching for paid concepts like epics or iterations. Tier notes below are verified against the GitLab docs; when a feature is ambiguous, check the tier (recipe at the end) before relying on it.

### Tiers at a glance

| Feature | Free | Notes |
|---|---|---|
| Project issue boards | ✅ multiple | Group issue boards: **1** on Free |
| Configurable boards / assignee lists | ❌ | Premium |
| Milestones (project + group) | ✅ | start/due dates, burndown & burnup charts |
| Labels (plain, priorities, colors) | ✅ | scoped labels (`status::todo`) are **Premium** |
| Quick actions | ✅ | see table below |
| Due dates | ✅ | `/due in 2 days`, `/due this Friday` |
| Time tracking | ✅ | `/estimate`, `/spend`; timelog report |
| Cross-linking issues | ✅ | `#123`, `group/project#123`, full URLs |
| Confidential issues | ✅ | |
| CSV export / import | ✅ | export is emailed as a CSV attachment |
| To-Do List | ✅ | `/todo`, mark done |
| Service Desk | ✅ | feature-frozen, not under active development |
| Releases | ✅ basic | group-level release metrics are Ultimate |
| Linked / blocking issues | ✅ | `/relate`, `/blocked_by`, `/blocks`, `/unlink` |
| Weight | ⚠️ verify | shown on cards; confirm the API accepts it on Free |
| Health status | ❌ Ultimate | |
| Status (custom workflow) | ❌ Premium | |
| Iterations | ❌ Premium | |
| Epics / Roadmap | ❌ Premium | |
| Saved views / Workplan | ⚠️ verify | check tier before using |

### Milestones — the Free planning backbone

Milestones are the closest Free equivalent to sprints. A milestone groups issues and merge requests toward a goal, with optional **start and due dates**. Group milestones can be applied to issues in any project of the group.

```bash
# list / create / close
glab api "projects/:id/milestones?state=active"
glab api --method POST "projects/:id/milestones" \
  --raw-field title="Sprint 12" --raw-field start_date=2026-10-20 --raw-field due_date=2026-11-01
glab api --method PUT "projects/:id/milestones/<milestone_id>" --raw-field state_event=close

# assign to an issue (id, not title)
glab issue update 42 --milestone "Sprint 12"     # or via quick action: /milestone %"Sprint 12"
```

- Use **milestones** when you need a timebox; use **boards** when you need flow.
- The milestone view has burndown/burnup charts for free.
- Milestone assignment is a single field — swapping it is idempotent, unlike labels.

### Quick actions — fastest way to mutate an issue

Quick actions are typed into the description or a comment and execute on save. They are all Free unless noted. They are the most token-efficient way to set several fields at once.

| Action | Example | Effect |
|---|---|---|
| `/board_move` | `/board_move ~"In Progress"` | move card (only if the project has **one** board) |
| `/label` | `/label ~bug ~"status::todo"` | add labels (scoped labels Premium) |
| `/unlabel` | `/unlabel ~bug` | remove a label |
| `/milestone` | `/milestone %"Sprint 12"` | set milestone |
| `/due` | `/due in 2 days` | due date |
| `/estimate` | `/estimate 8h` | time estimate |
| `/spend` | `/spend 1h 2026-10-19` | log time |
| `/relate` | `/relate #123` | mark related (non-blocking) |
| `/blocked_by` | `/blocked_by #123` | this is blocked by #123 |
| `/blocks` | `/blocks #123` | this blocks #123 |
| `/unlink` | `/unlink #123` | remove a link/block |
| `/assign` | `/assign @alex` | assignee |
| `/todo` | `/todo` | add to your To-Do List |
| `/close`, `/reopen` | `/close` | state |
| `/confidential` | `/confidential` | mark confidential |
| `/duplicate` | `/duplicate #99` | close as duplicate |
| `/promote_to` | `/promote_to Incident` | change work item type |

Post them with a note:

```bash
glab issue note 42 -m "/label ~bug
/due in 2 days
/blocked_by #17"
```

Do **not** use `/board_move` as your general move mechanism — it requires a single board and hides which label it swapped. The `glab issue update --label … --unlabel …` swap in [Moving a card](#moving-a-card-between-columns) is the reliable path.

### Metadata the board does not show

Some fields are useful for triage even though they never become a column:

- **Due dates** — `/due`, `glab issue update 42 --due-date 2026-11-01`.
- **Time tracking** — `/estimate 8h`, `/spend 2h`; read totals from the issue JSON.
- **Cross-links / blocking** — `/relate`, `/blocked_by`, `/blocks`. This is how you express dependencies on Free; there is no dependency-graph UI.
- **Confidentiality** — `/confidential` for security-sensitive work.
- **To-Do List** — `/todo` puts an item on your personal list; the API is `glab api "todos"` and `glab api --method POST "todos" --raw-field target_type=Issue --raw-field target_id=<id>`.
- **CSV** — export for offline analysis, import to bulk-create issues. Export is **per project**, not per group, and arrives by email.

```bash
# bulk-create from CSV (Free)
glab api --method POST "projects/:id/issues/import" --form file=@issues.csv
```

### What you cannot do on Free (don't design around it)

- **No scoped labels** (`status::todo`). Keep one status yourself by always swapping labels.
- **No epics, iterations, roadmap, or health status.** Use parent issues, milestones, and due dates instead.
- **No configurable boards, assignee lists, or milestone lists.** Columns are label-backed only.
- **Only one group board.** Multiple project boards are fine.
- **No custom issue status workflow.** Open/closed plus labels is the whole state machine.

### Verify a feature's tier before using it

```bash
glab api "projects/:id" | python3 -c "import sys,json; print(json.load(sys.stdin)['namespace']['id'])"
glab api "namespaces/<namespace_id>" | python3 -c "import sys,json; print(json.load(sys.stdin).get('plan'))"
```

If the plan is `free`, treat any feature above marked ⚠️ or ❌ as unavailable and fall back to labels + milestones.

## Common Mistakes

| Mistake | Why it's wrong / what to do |
|---|---|
| Inventing labels (`bug`, `enhancement`) | Splits the taxonomy. Read `glab label list` and reuse what exists. |
| Creating an issue with no status label | It matches no column, so it never appears on the board. Always set exactly one status. |
| Applying two status labels | Plain labels are not mutually exclusive — the card shows in two columns at once. Swap, don't add. |
| Using `glab issue board view` | Interactive TUI; it hangs or fails without a TTY. Read the board via `glab api`. |
| Expecting columns in `glab issue board create` | There are no such flags; the board is created empty. |
| Using `glab issue list -F json` | `list` uses `-O json`; `view` uses `-F json`. Not interchangeable. |
| Hardcoding the project id | `glab api` accepts `:id` (numeric) and `:fullpath` (encoded path). |
| Deleting to "clean up" | `glab issue delete` is irreversible and does not prompt. Close instead. |
| Assuming scoped labels work | `status::todo` is Premium/Ultimate only. On Free, use plain labels and keep one status yourself. Check the tier (Quick Reference) before proposing scoped labels. |
| Assuming closed means off the board | State and column are independent; a closed issue keeps its label and its card. |

## Gotchas worth knowing before you start

- `glab issue board` has exactly two subcommands — `create` and `view`. No column management, no delete, no reorder. Everything structural is `glab api`.
- **Free tier limits:** multiple *project* boards are allowed; only one *group* board; assignee lists, milestone lists and configurable boards are paid tiers.
- `glab issue delete <iid>` deletes immediately with no confirmation prompt.
- Long descriptions: `-d -` reads stdin, and `--description-file <path>` reads a file (`-` for stdin). Prefer these over inlining multi-line text.
- Working against another repo: `-R OWNER/REPO`, or a full URL. Board/user ids you collected elsewhere will not apply.

## Verify before reporting

```bash
glab api "projects/:id/boards/<board_id>"     # columns present, in the order you intended
glab api "projects/:id/issues/<iid>"          # exactly one status label
```

Then report the issue URL. Confirm the card actually sits in the column you meant — not just that the command exited 0.
