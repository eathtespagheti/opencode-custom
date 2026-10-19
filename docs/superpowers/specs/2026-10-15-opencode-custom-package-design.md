# opencode-custom — design note

Date: 2026-10-15

## Intent and why

My OpenCode customizations (the `unattended` overnight-mode plugin and the
`gitlab-issue-board` skill) lived loose in `~/.config/opencode/{plugins,commands,scripts,skills}`.
That directory is not a repo, mixes my work with API tokens, `node_modules`, and
third-party skills, and cannot be installed on a new machine in one step.

I want my own work tracked in a public GitLab repo and installed/updated on any
machine with a single command, with no secrets involved.

## Goals

- One repo containing only work I wrote: `unattended` (plugin + commands + skill
  + scripts) and the `gitlab-issue-board` skill.
- Install and update through OpenCode itself, not by copying files:
  `opencode plugin add` / `opencode plugin update`.
- Correct on every machine — no hard-coded `~/.config/opencode/...` paths.
- Keep the existing behaviour and the acceptance tests.

## Non-goals

- Not a dump of `~/.config/opencode`. Third-party skills (`obsidian-*`,
  `json-canvas`), `AGENTS.md`, MCP/model config, tokens, and lockfiles stay out.
- Not an npm publish. Git install only.
- No behaviour changes to unattended mode itself.

## Anti-goals (would make this a failure)

- A repo that could leak a token.
- An install that needs hand-editing files per machine.
- A packaged plugin that loads but silently fails to register skills/commands.

## Constraints (from the OpenCode V2 docs)

- V2 plugins register skills with `ctx.skill.transform` and commands with
  `ctx.command.transform` (which takes `execute`, not a `template`).
- A command that submits through `ctx.session.prompt` still runs prompt hooks,
  so `/unattended` arms the sentinel as before.
- `opencode plugin add` accepts `git+https://…`; `plugin update` tracks the
  branch unless pinned.

## Decisions (mine, unless noted)

- **Package shape:** a plugin package with `package.json` (`type: module`,
  `main: index.js`) whose default export is `{ id, setup }` — the same
  dependency-free shape as `superpowers`. *User decided:* public repo.
- **Registration, not discovery:** skills and commands are registered from the
  package at load (`ctx.skill`/`ctx.command` transforms), because
  `~/.config/opencode/{skills,commands}` is not scanned inside an installed
  package.
- **Scripts move under the skill.** `unattended-digest.sh` and the self-test
  live beside `skills/unattended/SKILL.md`. The skill references the digest via
  `{{DIGEST_SCRIPT}}`, which `index.js` replaces with the real install path.
- **Source files:** `plugins/unattended.ts` becomes `lib/unattended.js` (it was
  already plain JS under `@ts-nocheck`).
- **Tests stay:** `test/plugin.test.mjs` covers registration; the original
  `unattended-selftest.mjs` is retargeted at `lib/unattended.js`.

## Verified

- `node test/plugin.test.mjs` — 25 checks (2 skills, 2 commands, hooks, cleanup).
- `node skills/unattended/scripts/unattended-selftest.mjs` — 19 checks.
- A real `opencode serve` in an isolated XDG config listing `/api/skill` and
  `/api/command` shows both skills and both commands, with the digest path
  resolved and no leftover placeholder.

## Left to the maintainer

- License: GNU General Public License v3.0 (see `LICENSE`).

## Done

- Repo created (public) and pushed; `opencode plugin add` installed on this
  machine and verified — the skills/commands load from the installed package.
- Duplicated copies moved out of `~/.config/opencode`: `skills/unattended`,
  `skills/gitlab-issue-board`, `plugins/unattended.ts`,
  `commands/unattended*.md`, `scripts/unattended-*`.
