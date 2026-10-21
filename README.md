# opencode-custom

Copyright (C) 2026 Fabio Sussarellu. Licensed under the GNU General Public License v3.0 — see [LICENSE](LICENSE).

My personal [OpenCode](https://opencode.ai) customizations, packaged as an
installable plugin so they follow me across machines and stay in sync through
git.

It ships three things, all written by me:

- **`unattended`** — flip a *session* into overnight mode. The plugin owns a
  per-session record, keeps the "no questions, decide conservatively" contract
  alive across compaction and idle pauses, and logs every autonomous decision.
  Also provides the `/unattended` and `/unattended-off` commands and a digest
  script. `/unattended-off` is an in-place handover: the task keeps running,
  the session starts asking questions again, and you get a summary of the
  decisions made while unattended.
- **`gitlab-issue-board`** — a skill for driving GitLab issue *boards* (columns
  are labels) through `glab` and the GitLab API, plus the rest of the Free-tier
  planning stack: milestones, labels, quick actions, due dates, time tracking,
  cross-links, CSV import/export, the To-Do List, and service desk.

## Install

```bash
opencode plugin add git+https://gitlab.com/eathtespagheti/opencode-custom.git
```

That records the plugin in `~/.config/opencode/opencode.jsonc` and loads it on
every session. Or add it to the `plugins` array yourself:

```jsonc
{
  "plugins": ["git+https://gitlab.com/eathtespagheti/opencode-custom.git"]
}
```

Have only one entry pointing at this plugin. A `git+https://…` install and a
local path both load and *deduplicate* into whichever comes first, so a locally
edited copy appears never to take effect — a stale `opencode.json(c)` beside your
`opencode.jsonc` counts here.

## Docs keeping (`docs-keeper`, `docs-sync`)

`docs-keeper` is a subagent, `docs-sync` the skill it follows. Between them they
keep a repository's documentation truthful against the code that generates it:
map a change onto the doc surfaces it affects, edit those, then verify with the
shipped `skills/docs-sync/scripts/docs-check.sh` (broken markdown links + backticked paths that
do not resolve — the two checks that hold in any repository).

The plugin ships one generic implementation. Everything repo-specific — which
files are docs, what may be edited, and the change→doc mapping — lives in a
per-project config the plugin reads at load time and turns into the agent's
permission fence and prompt:

```jsonc name=.opencode/docs-sync.json (in the project)
{
  "sourceOfTruth": "flux/ manifests (never hand-edited docs)",
  "docs":         ["OVERVIEW.md", "README.md", "AGENTS.md", "flux/apps/**/README.md"],
  "readOnlyDocs": ["docs/superpowers/**"],
  "docMap":       "| Change | Docs to update |\n|---|---|\n| New app | OVERVIEW.md, root README |",
  "style":        "Preserve section numbering; one fact per bullet.",
  "check":        { "docs": ["README.md"], "skipDirs": ["docs/superpowers/"] }
}
```

| Field | Effect |
|---|---|
| `sourceOfTruth` | one line naming what the docs must mirror |
| `docs` | doc globs the agent may edit — this *is* the edit fence |
| `readOnlyDocs` | doc globs re-denied after the allow list |
| `docMap` | markdown table of change kinds → doc surfaces |
| `style` | prose conventions, injected into the agent prompt |
| `check.docs` | doc globs the checker scans (default: `docs`) |
| `check.skipDirs` | directories excluded from the checker |

With no config at all the plugin still registers both: the agent is read-only
(zero edit rules, only `git status/diff/log/show` and the checker script are
allowed), which is a safe starting point rather than a wrong one. Add the
config to get edit rights.

Two rules keep a project's own version of either intact, verified against a
live server:

- a project-level `.opencode/agents/docs-keeper.md` or
  `.opencode/skills/docs-sync/` always wins, and the plugin skips its own copy
  for that project;
- the agent's system prompt and permission fence are built per project
  location, so two projects served by one opencode process get their own.

Checker usage (read-only, exit 1 when it finds a `MISS`):

```bash
skills/docs-sync/scripts/docs-check.sh --root .
skills/docs-sync/scripts/docs-check.sh --root . --docs README.md --docs docs/
```

It needs bash + git + python3 (python3 is only used to read the project's
config when you have one) and no build step.

## Update / remove

```bash
opencode plugin update       # every plugin
opencode plugin update opencode-custom
opencode plugin remove opencode-custom
```

A tag or commit hash pins a version; the default tracks the branch.

## What it registers

The plugin's `setup(ctx)` runs once at load and uses the OpenCode V2 plugin API:

| Registered | How |
| --- | --- |
| `unattended`, `gitlab-issue-board`, `docs-sync` skills | `ctx.skill.transform(...)` — read from `skills/` |
| `docs-keeper` subagent (per-project fence + prompt) | `ctx.agent.transform(...)` — read from `agents/`, config from `.opencode/docs-sync.json` |
| `/unattended`, `/unattended-off` commands | `ctx.command.transform(...)` — read from `commands/` |
| per-session arming, contract re-injection, idle nudges, handover notice | `ctx.session.hook("prompt" \| "context")`, `ctx.event.subscribe`, `ctx.storage` |

No dependencies — plain ESM, the same shape the `superpowers` plugin uses.

## Layout

```text
index.js                            # plugin entry: { id, setup }
lib/
  unattended.js                     # the unattended plugin half (hooks, contract, nudges)
  unattended-state.js               # per-session state store + artifact paths
  register-skills.js                # skills/ -> native skills
  register-commands.js              # commands/ -> slash commands
  register-agents.js                # agents/ -> subagents ({{VAR}} substitution)
  docs-config.js                    # .opencode/docs-sync.json -> fence + prompt vars
  frontmatter.js                    # tiny SKILL.md frontmatter reader
skills/
  unattended/SKILL.md               # contract the agent loads
  unattended/scripts/               # digest + acceptance self-test
  gitlab-issue-board/SKILL.md       # boards + Free-tier planning toolkit
  docs-sync/SKILL.md                # the docs-sync procedure
  docs-sync/scripts/docs-check.sh   # generic doc consistency check
commands/
  unattended.md, unattended-off.md
docs/
  unattended.md                     # how the unattended mode works
  superpowers/specs/                # design notes
  superpowers/plans/                # implementation plans
agents/
  docs-keeper.md                    # generic subagent definition
test/
  plugin.test.mjs                   # skills, commands, hooks, per-session isolation
  docs-sync.test.py                 # checker script + agent/skill shape
```

## Develop

```bash
npm test                                                     # plugin registration
node skills/unattended/scripts/unattended-selftest.mjs       # unattended behaviour
```

```bash
python3 test/docs-sync.test.py       # docs-sync checker + agent/skill shape (no node needed)
```

The `npm test` suite drives the real code against a mock OpenCode V2 context —
no live TUI or model needed.

Both drive the real code against a mock OpenCode V2 context — no live TUI or
model needed.

## Notes

- Public repo: it contains no secrets. Your MCP servers, API keys, and model
  config stay in your local `~/.config/opencode/opencode.json(c)` and are never
  part of this package.
- The unattended skill points at its digest script via a `{{DIGEST_SCRIPT}}`
  placeholder; the plugin substitutes the real install path at load time, so it
  is correct on every machine.
