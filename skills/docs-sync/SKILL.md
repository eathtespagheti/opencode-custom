---
name: docs-sync
description: Procedure for keeping a repository's documentation in sync with its actual implementation. Load before updating project docs.
---

# docs-sync

Use this procedure whenever a change could make this repo's documentation wrong.
The repository's actual implementation is the source of truth; the docs describe
it. Never change the implementation to match a document.

## Step 0 — Establish the change set

- `git diff <base>...HEAD --stat` and `git log` for the handed-off change.
- Read the changed sources themselves. Do not rely on the handoff summary alone.

## Step 1 — Map changes to docs

Read the project configuration at `.opencode/docs-sync.json` in the repository
root if it exists (see *Project configuration* below). Use its `docMap` when it
declares one. Otherwise infer the mapping yourself: list the doc surfaces
(`README.md` files, `AGENTS.md`, `docs/**`, `CHANGELOG.md`...), read enough of
each to know what it covers, and assign each change to the surfaces it affects.

| Change | Docs to update |
|---|---|
| Documented interface (API, CLI, config, schema, protocol) | the doc surface that covers that interface |
| New/removed/renamed file, directory, or module | inventories and per-surface docs |
| Behaviour, defaults, or flows | per-surface guides |
| Build, deploy, ports, images, environment | deploy sections and root README |
| Agent conventions and commands | root `AGENTS.md` and the scoped `AGENTS.md` |

## Step 2 — Update each doc

Match the surrounding prose. Preserve existing conventions (the config's `style`
field and each surface's own style when they conflict with anything generic).
Do not restructure, do not invent content you cannot verify from the sources,
and do not create new files unless the change warrants a doc surface that has
no home.

## Step 3 — Run the consistency check

Run `{{DOCS_CHECK_SCRIPT}} --root .` (read-only). Reason only about its
`MISS`/`WARN` lines plus the Step 1 change set. A clean run is the evidence for
"no change needed"; do not perform a whole-repo manual sweep in sync mode.

## Step 4 — Report

Use the report format in the `docs-keeper` agent. Never commit; return the edits
and the report to the caller.

## Modes

- **sync** (default): scoped to the handed-off change, script-driven.
- **audit** (only when explicitly requested): a full pass over every doc surface;
  update or create what is missing. Expensive.

## Project configuration

`.opencode/docs-sync.json` in the repository root makes the procedure
repo-specific. Every field is optional:

| Field | Meaning |
|---|---|
| `sourceOfTruth` | one line describing what the docs must mirror |
| `docs` | doc path globs the agent may edit (this is also the edit fence) |
| `readOnlyDocs` | doc path globs never editable (default `docs/superpowers/**`) |
| `docMap` | markdown table mapping change kinds to doc surfaces |
| `style` | prose describing this repo's doc conventions |
| `check.docs` | doc path globs the checker scans (default: the `docs` globs) |
| `check.skipDirs` | directories excluded from the checker |

Without a config the procedure still works: it discovers the doc surfaces from
the repository, and the checker scans every `*.md` outside vendor directories.

## Report format

```
## docs-sync report
Mode:              sync | audit
Change:            <one line>
Files changed:     <path — what and why>
Checked, no change:<docs + what was verified>
Uncertain:         <question(s); affected docs left untouched>
```
