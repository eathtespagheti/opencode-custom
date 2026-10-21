// Unit test for the opencode-custom plugin package.
//
// Drives the real plugin against a mock OpenCode V2 ctx (no live TUI, no model)
// and asserts what it registers: the two skills, the two commands, the
// unattended hooks, per-session isolation, and the off handover.
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

// A legacy project-wide flag must arm nobody.
fs.mkdirSync(path.join(PROJECT, ".opencode", "unattended"), { recursive: true })
fs.writeFileSync(path.join(PROJECT, ".opencode", "unattended", "ACTIVE"), "legacy\n")

process.env.UNATTENDED_DEBUG = "1"
process.env.UNATTENDED_NUDGE_MIN_MS = "10"
process.env.UNATTENDED_MAX_NUDGES = "5"

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
const storage = new Map()
const events = []
const contexts = new Map()
const rpcs = new Map()
const rpcEvents = []

const storageApi = {
  get: async (key) => storage.get(key),
  set: async (key, value) => { storage.set(key, structuredClone(value)) },
  remove: async (key) => { storage.delete(key) },
  scan: async ({ prefix }) => ({
    entries: [...storage.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  }),
}

const ctx = {
  location: { directory: PROJECT },
  storage: storageApi,
  skill: {
    transform: async (cb) => cb({ add: (def) => { skills.set(def.id, def) } }),
  },
  command: {
    transform: async (cb) => cb({ add: (def) => { commands.set(def.name, def) } }),
  },
  session: {
    hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} } },
    get: async ({ sessionID }) => ({
      sessionID,
      parentID: sessionID.includes("child") ? "ses_parent" : undefined,
      directory: PROJECT,
    }),
    context: async ({ sessionID }) => contexts.get(sessionID) || [],
    prompt: async (input) => { prompts.push(input); return {} },
  },
  event: {
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          if (events.length) { yield events.shift(); continue }
          await new Promise((r) => setTimeout(r, 2))
        }
      },
    }),
  },
  rpc: {
    register: async (definition, implementation) => {
      rpcs.set(definition?.id, { definition, implementation })
      return {
        dispose: () => rpcs.delete(definition?.id),
        events: {
          emit: async (name, payload) => {
            rpcEvents.push({ id: definition?.id, name, payload })
            return true
          },
        },
      }
    },
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const record = (sessionID) => storage.get(`unattended/session/${sessionID}`)
const partsText = (parts) => parts.map((p) => String(p?.text ?? "")).join("\n")

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
check("running /unattended submits the ON marker", prompts.at(-1)?.text?.includes("[[opencode-unattended:on]]"))

await commands.get("unattended-off").execute({ sessionID: "ses_1", prompt: { text: "/unattended-off" }, delivery: "steer" })
check("running /unattended-off submits the OFF marker", prompts.at(-1)?.text?.includes("[[opencode-unattended:off]]"))

// Hooks
check("registers a prompt hook", typeof hooks.prompt === "function")
check("registers a context hook", typeof hooks.context === "function")

// ── Per-session arming ───────────────────────────────────────────────────────
await hooks.prompt({ sessionID: "ses_a", prompt: { text: "go [[opencode-unattended:on]]" } })
check("prompt hook arms session A", record("ses_a")?.armed === true)
check("prompt hook leaves session B unarmed", record("ses_b") === undefined)

const legacyArmedNobody = []
await hooks.context({ sessionID: "ses_legacy", system: legacyArmedNobody, messages: [] })
check("legacy project-wide ACTIVE arms nobody", !partsText(legacyArmedNobody).includes("[[UNATTENDED-MODE-ACTIVE]]"))

// B's requests never receive A's contract.
const bSystem = []
await hooks.context({ sessionID: "ses_b", system: bSystem, messages: [] })
check("session B gets no contract", !partsText(bSystem).includes("[[UNATTENDED-MODE-ACTIVE]]"))

// A's request carries the contract with absolute, per-session paths.
const aSystem = []
await hooks.context({ sessionID: "ses_a", system: aSystem, messages: [] })
const aText = partsText(aSystem)
check("session A gets the contract", aText.includes("[[UNATTENDED-MODE-ACTIVE]]"))
check("contract names the session", aText.includes("ses_a"))
check("contract uses absolute per-session paths",
  aText.includes(path.join(PROJECT, ".opencode", "unattended", "sessions", "ses_a", "decisions.jsonl")))
check("contract does not use the legacy shared path",
  !aText.includes(path.join(PROJECT, ".opencode", "unattended", "decisions.jsonl")))

// ── Off is local and injects the handover notice once ────────────────────────
await hooks.prompt({ sessionID: "ses_a", prompt: { text: "stop [[opencode-unattended:off]]" } })
check("off disarms A", record("ses_a")?.armed === false)
check("off requests the summary notice", record("ses_a")?.pendingNotice === true)
check("off leaves B untouched", record("ses_b") === undefined)

const aOff = []
await hooks.context({ sessionID: "ses_a", system: aOff, messages: [] })
const aOffText = partsText(aOff)
check("off notice is injected", aOffText.includes("[[UNATTENDED-MODE-OFF]]"))
check("off notice names the armed-at boundary", aOffText.includes(record("ses_a")?.armedAt))
check("stale contract is removed on handover", !aOffText.includes("[[UNATTENDED-MODE-ACTIVE]]"))
check("pending notice is cleared", record("ses_a")?.pendingNotice === false)

const aAgain = []
await hooks.context({ sessionID: "ses_a", system: aAgain, messages: [] })
check("off notice is not repeated", !partsText(aAgain).includes("[[UNATTENDED-MODE-OFF]]"))

// A stale ON in history must not re-arm an explicitly disarmed session.
const staleOn = [{ role: "user", content: [{ type: "text", text: "[[opencode-unattended:on]]" }] }]
const staleSystem = []
await hooks.context({ sessionID: "ses_a", system: staleSystem, messages: staleOn })
check("stale ON does not re-arm an off session", record("ses_a")?.armed === false)
check("stale ON produces no contract", !partsText(staleSystem).includes("[[UNATTENDED-MODE-ACTIVE]]"))

// ── Bootstrap from history ──────────────────────────────────────────────────
const histMessages = [
  { role: "user", content: [{ type: "text", text: "[[opencode-unattended:on]]" }] },
  { role: "assistant", content: [{ type: "text", text: "working" }] },
  { role: "user", content: [{ type: "text", text: "[[opencode-unattended:off]]" }] },
]
const histSystem = []
await hooks.context({ sessionID: "ses_hist", system: histSystem, messages: histMessages })
check("bootstrap ON then OFF ends disarmed", record("ses_hist")?.armed !== true)
check("bootstrap OFF does not request a summary", record("ses_hist")?.pendingNotice !== true)

const bootMessages = [{ role: "user", content: [{ type: "text", text: "[[opencode-unattended:on]]" }] }]
const bootSystem = []
await hooks.context({ sessionID: "ses_boot", system: bootSystem, messages: bootMessages })
check("bootstrap ON arms the session", record("ses_boot")?.armed === true)
check("bootstrap ON injects the contract", partsText(bootSystem).includes("[[UNATTENDED-MODE-ACTIVE]]"))

// Injected blocks must never be read as markers.
const injectedMessages = [
  { role: "user", content: [{ type: "text", text: "[[UNATTENDED-MODE-ACTIVE]]\nwrite [[opencode-unattended:off]] at the end" }] },
]
const injectedSystem = []
await hooks.context({ sessionID: "ses_boot", system: injectedSystem, messages: injectedMessages })
check("markers inside injected text are ignored", record("ses_boot")?.armed === true)

// ── Child sessions ─────────────────────────────────────────────────────────
await hooks.prompt({ sessionID: "ses_child_1", prompt: { text: "[[opencode-unattended:on]]" } })
check("child sessions are never armed", record("ses_child_1") === undefined)

const childSystem = []
await hooks.context({ sessionID: "ses_child_1", system: childSystem, messages: bootMessages })
check("child sessions get no contract", !partsText(childSystem).includes("[[UNATTENDED-MODE-ACTIVE]]"))

// ── Idle nudges ────────────────────────────────────────────────────────────
await hooks.prompt({ sessionID: "ses_nudge", prompt: { text: "[[opencode-unattended:on]]" } })
events.push({ type: "session.idle", sessionID: "ses_nudge" })
await sleep(80)
check("armed session is nudged on idle",
  prompts.some((p) => p.sessionID === "ses_nudge" && p.text.includes("[[opencode-unattended:nudge]]")))
check("nudge uses queue delivery", prompts.find((p) => p.sessionID === "ses_nudge")?.delivery === "queue")

// Disarmed sessions are not nudged.
events.push({ type: "session.idle", sessionID: "ses_a" })
await sleep(60)
check("disarmed session is not nudged", !prompts.some((p) => p.sessionID === "ses_a"))

// ── Natural end of run ─────────────────────────────────────────────────────
await hooks.prompt({ sessionID: "ses_end", prompt: { text: "[[opencode-unattended:on]]" } })
contexts.set("ses_end", [
  { role: "assistant", content: [{ type: "text", text: "all done [[opencode-unattended:off]]" }] },
])
events.push({ type: "session.idle", sessionID: "ses_end" })
await sleep(80)
check("assistant end marker disarms silently", record("ses_end")?.armed === false)
check("assistant end marker requests no summary", record("ses_end")?.pendingNotice !== true)
check("assistant end marker suppresses the nudge", !prompts.some((p) => p.sessionID === "ses_end"))

// ── RPC: the read-only projection of the state, for the TUI ─────────────────
check("registers the unattended RPC", rpcs.has("unattended"))
const rpc = rpcs.get("unattended")
check("RPC exposes a status method", typeof rpc?.implementation?.status === "function")
check("RPC contract has an id and a changed event",
  rpc?.definition?.id === "unattended" && !!rpc?.definition?.events?.changed)

const rpcStatus = async (sessionID) => rpc.implementation.status({ sessionID })
check("RPC status is off for an unknown session", (await rpcStatus("ses_never"))?.armed === false)
check("RPC status is on for an armed session", (await rpcStatus("ses_boot"))?.armed === true)
check("RPC status carries the armed-at stamp", typeof (await rpcStatus("ses_boot"))?.since === "string")
check("RPC status is off for a disarmed session", (await rpcStatus("ses_a"))?.armed === false)

const armEvent = rpcEvents.find((e) => e.id === "unattended" && e.name === "changed" && e.payload?.armed === true)
check("arming emits a changed event", !!armEvent)
check("the changed event names the session", armEvent?.payload?.sessionID === "ses_a")

const disarmEvent = rpcEvents.find((e) => e.id === "unattended" && e.name === "changed" && e.payload?.armed === false)
check("disarming emits a changed event", !!disarmEvent)
check("the changed event names the disarmed session", disarmEvent?.payload?.sessionID === "ses_a")

// ── Indicator: unknown is not off ────────────────────────────────────────────
const { createIndicator } = await import(path.join(ROOT, "lib", "indicator.js"))

const fakeApi = (armed) => ({
  status: async () => ({ armed }),
  events: { on: () => () => {} },
})

const failing = createIndicator({
  api: { status: async () => { throw new Error("rpc.unavailable") }, events: { on: () => () => {} } },
  retryDelays: [],
})
await failing.refresh("ses_x")
check("a failing status leaves the state unknown", failing.get("ses_x") === undefined)
check("a failing status does not claim 'off'", failing.isKnown("ses_x") === false)

const off = createIndicator({ api: fakeApi(false), retryDelays: [] })
await off.refresh("ses_off")
check("a known state is remembered", off.get("ses_off")?.armed === false)

const on = createIndicator({ api: fakeApi(true), retryDelays: [] })
await on.refresh("ses_on")
check("an armed session is remembered", on.get("ses_on")?.armed === true)

let notifications = 0
const watched = createIndicator({ api: fakeApi(false), retryDelays: [] })
watched.subscribe(() => { notifications++ })
await watched.refresh("ses_w")
check("a new state notifies the view", notifications === 1)
await watched.refresh("ses_w")
check("an unchanged state does not notify the view", notifications === 1)

watched.applyEvent({ sessionID: "ses_w", armed: true })
check("a change event updates the state", watched.get("ses_w")?.armed === true)
check("a change event notifies the view", notifications === 2)

const malformed = createIndicator({
  api: { status: async () => ({}), events: { on: () => () => {} } },
  retryDelays: [],
})
await malformed.refresh("ses_bad")
check("an unreadable status response leaves the state unknown", malformed.get("ses_bad") === undefined)

const badEvent = createIndicator({ api: fakeApi(false), retryDelays: [] })
badEvent.applyEvent({ sessionID: "ses_e" })
check("an event without a boolean armed is ignored", badEvent.get("ses_e") === undefined)

// ── Cleanup ────────────────────────────────────────────────────────────────
cleanup()
await sleep(20)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
