# opencode-custom

Copyright (C) 2026 Fabio Sussarellu. Licensed under the GNU General Public License v3.0 — see [LICENSE](LICENSE).

My personal [OpenCode](https://opencode.ai) customizations, packaged as an
installable plugin so they follow me across machines and stay in sync through
git.

It ships two things, both written by me:

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
| `unattended`, `gitlab-issue-board` skills | `ctx.skill.transform(...)` — read from `skills/` |
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
  frontmatter.js                    # tiny SKILL.md frontmatter reader
skills/
  unattended/SKILL.md               # contract the agent loads
  unattended/scripts/               # digest + acceptance self-test
  gitlab-issue-board/SKILL.md       # boards + Free-tier planning toolkit
commands/
  unattended.md, unattended-off.md
docs/
  unattended.md                     # how the unattended mode works
  superpowers/specs/                # design notes
  superpowers/plans/                # implementation plans
test/
  plugin.test.mjs                   # skills, commands, hooks, per-session isolation
```

## Develop

```bash
npm test                                                     # plugin registration
node skills/unattended/scripts/unattended-selftest.mjs       # unattended behaviour
```

Both drive the real code against a mock OpenCode V2 context — no live TUI or
model needed.

## Notes

- Public repo: it contains no secrets. Your MCP servers, API keys, and model
  config stay in your local `~/.config/opencode/opencode.json(c)` and are never
  part of this package.
- The unattended skill points at its digest script via a `{{DIGEST_SCRIPT}}`
  placeholder; the plugin substitutes the real install path at load time, so it
  is correct on every machine.
