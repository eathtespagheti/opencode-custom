// Unit test for the opencode-custom plugin package.
//
// Drives the real plugin against a mock OpenCode V2 ctx (no live TUI, no model)
// and asserts what it registers: the two skills, the two commands, the
// unattended hooks, and a cleanup function.
//
// Run:  node test/plugin.test.mjs
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const PROJECT = "/tmp/opencode/opencode-custom-test-project"
fs.rmSync(PROJECT, { recursive: true, force: true })
fs.mkdirSync(PROJECT, { recursive: true })

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`ok   - ${name}`) }
  else { fail++; console.log(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`) }
}

// ── Mock V2 ctx ──────────────────────────────────────────────────────────────
const skills = new Map()
const commands = new Map()
const hooks = {}
const prompts = []

const ctx = {
  location: { directory: PROJECT },
  skill: {
    transform: async (cb) => cb({ add: (def) => { skills.set(def.id, def) } }),
  },
  command: {
    transform: async (cb) => cb({ add: (def) => { commands.set(def.name, def) } }),
  },
  session: {
    hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} } },
    get: async ({ sessionID }) => ({ sessionID, parentID: undefined, directory: PROJECT }),
    prompt: async (input) => { prompts.push(input); return {} },
  },
  event: {
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) { await new Promise((r) => setTimeout(r, 2)) }
      },
    }),
  },
}

// ── Drive the plugin ─────────────────────────────────────────────────────────
const plugin = (await import(path.join(ROOT, "index.js"))).default

check("default export has an id", typeof plugin?.id === "string" && plugin.id.length > 0)
check("default export has setup()", typeof plugin?.setup === "function")

const cleanup = await plugin.setup(ctx)
check("setup() returns a cleanup function", typeof cleanup === "function")

// Skills
check("registers the gitlab-issue-board skill", skills.has("gitlab-issue-board"))
check("registers the unattended skill", skills.has("unattended"))

for (const id of ["gitlab-issue-board", "unattended"]) {
  const s = skills.get(id)
  check(`skill "${id}" has a name`, typeof s?.name === "string" && s.name.length > 0)
  check(`skill "${id}" has a description`, typeof s?.description === "string" && s.description.length > 0)
  check(`skill "${id}" path is absolute and points at its SKILL.md`,
    typeof s?.path === "string" && path.isAbsolute(s.path) && s.path.endsWith(path.join("skills", id, "SKILL.md")))
  check(`skill "${id}" content is non-empty`, typeof s?.content === "string" && s.content.trim().length > 0)
}

check("unattended skill has no unresolved {{placeholder}}",
  !skills.get("unattended")?.content?.includes("{{"))

// Commands
check("registers the unattended command", commands.has("unattended"))
check("registers the unattended-off command", commands.has("unattended-off"))
for (const name of ["unattended", "unattended-off"]) {
  const c = commands.get(name)
  check(`command "${name}" has a description`, typeof c?.description === "string" && c.description.length > 0)
  check(`command "${name}" has an execute function`, typeof c?.execute === "function")
}

await commands.get("unattended").execute({ sessionID: "ses_1", prompt: { text: "/unattended" }, delivery: "steer" })
check("running /unattended submits the ON marker",
  prompts.some((p) => typeof p?.text === "string" && p.text.includes("[[opencode-unattended:on]]")))

await commands.get("unattended-off").execute({ sessionID: "ses_1", prompt: { text: "/unattended-off" }, delivery: "steer" })
check("running /unattended-off submits the OFF marker",
  prompts.some((p) => typeof p?.text === "string" && p.text.includes("[[opencode-unattended:off]]")))

// Hooks (the unattended glue)
check("registers a prompt hook", typeof hooks.prompt === "function")
check("registers a context hook", typeof hooks.context === "function")

// Arming via the prompt hook writes the sentinel (deterministic arming).
await hooks.prompt({ sessionID: "ses_1", prompt: { text: "please [[opencode-unattended:on]] until morning" } })
check("prompt hook arms the sentinel",
  fs.existsSync(path.join(PROJECT, ".opencode", "unattended", "ACTIVE")))

cleanup()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
