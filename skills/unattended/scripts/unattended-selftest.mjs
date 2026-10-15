// Acceptance self-test for lib/unattended.js (the unattended half of the
// opencode-custom package).
//
// Drives the plugin with a mock OpenCode V2 ctx (no live TUI, no model).
//
// Run:  node skills/unattended/scripts/unattended-selftest.mjs
import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const HERE = path.dirname(fileURLToPath(import.meta.url)) // .../skills/unattended/scripts
const PKG_ROOT = path.resolve(HERE, "..", "..", "..")      // package root
const PROJECT = "/tmp/opencode/unattended-selftest-project"

fs.rmSync(PROJECT, { recursive: true, force: true })
fs.mkdirSync(PROJECT, { recursive: true })

process.env.UNATTENDED_DEBUG = "1"
process.env.UNATTENDED_NUDGE_MIN_MS = "100"
process.env.UNATTENDED_MAX_NUDGES = "3"

const { default: plugin } = await import(path.join(PKG_ROOT, "lib", "unattended.js"))

const stateDir = path.join(PROJECT, ".opencode", "unattended")
const activePath = path.join(stateDir, "ACTIVE")

const hooks = {}
const prompts = []
let queue = []

const ctx = {
  location: { directory: PROJECT },
  session: {
    hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} } },
    get: async ({ sessionID }) => ({ sessionID, parentID: undefined, directory: PROJECT }),
    prompt: async (input) => { prompts.push(input); return {} },
  },
  event: {
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          if (queue.length) { yield queue.shift(); continue }
          await new Promise((r) => setTimeout(r, 2))
        }
      },
    }),
  },
}

const cleanup = await plugin.setup(ctx)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`) }
}

console.log("── Acceptance tests ─────────────────────────────────────────")

// 1. Arming (live-session test #1, simulated through the real hooks)
check("plugin registered the context hook", typeof hooks.context === "function")
check("plugin registered the prompt hook", typeof hooks.prompt === "function")
if (hooks.prompt) {
  hooks.prompt({ sessionID: "S1", prompt: { text: "I'm going to bed — /unattended — see you tomorrow. [[opencode-unattended:on]]" } })
} else if (hooks.context) {
  await hooks.context({ sessionID: "S1", system: [], messages: [{ role: "user", content: [{ type: "text", text: "[[opencode-unattended:on]]" }] }] })
}
await sleep(20)
check("1. /unattended creates the ACTIVE sentinel", fs.existsSync(activePath))

// 2. Compaction survival (test #2)
const ctxEvent = { sessionID: "S1", system: [], messages: [{ role: "user", content: [{ type: "text", text: "keep going" }] }] }
queue.push({ type: "session.compacted", sessionID: "S1" })
await sleep(40)
await hooks.context(ctxEvent)
const guardCount = () => ctxEvent.system.filter((p) => String(p?.text || "").includes("[[UNATTENDED-MODE-ACTIVE]]")).length
check("2. contract injected into event.system after compaction", guardCount() === 1, JSON.stringify(ctxEvent.system))
await hooks.context(ctxEvent)
check("2b. re-injection is deduplicated", guardCount() === 1)

// 3. Idle nudge + debounce + cap (tests #3/#4)
prompts.length = 0
queue.push({ type: "session.idle", sessionID: "S1" })
queue.push({ type: "session.idle", sessionID: "S1" })
await sleep(60)
check("3. idle produces a nudge", prompts.length === 1, "prompts=" + prompts.length)
check("3b. nudge is debounced (burst -> one)", prompts.length === 1, "prompts=" + prompts.length)
check("3c. nudge carries the nudge marker", String(prompts[0]?.text || "").includes("[[opencode-unattended:nudge]]"))
check("3d. nudge delivery is queue", prompts[0]?.delivery === "queue")
for (let i = 0; i < 4; i++) { await sleep(160); queue.push({ type: "session.idle", sessionID: "S1" }) }
await sleep(220)
check("3e. idle-nudge cap is respected (max 3)", prompts.length === 3, "prompts=" + prompts.length)

// 4. Decision log (test #4)
const jsonlPath = path.join(stateDir, "decisions.jsonl")
const jsonl = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf8") : ""
check("4. decisions.jsonl records a decision with rationale", jsonl.includes('"event":"activated"') && jsonl.includes('"rationale"'))

// 5 + 7. Escalation and digest (tests #5, #7)
fs.appendFileSync(jsonlPath, JSON.stringify({
  ts: new Date().toISOString(), task: "deploy", question: "push to prod?",
  options: ["yes", "no"], chosen: "no", rationale: "irreversible — escalated, not performed",
  reversible: false, escalate: true,
}) + "\n")
fs.writeFileSync(path.join(stateDir, "SUMMARY.md"), "# Summary\n\n- did things\n- 1 escalation\n")
const digest = spawnSync("bash", [path.join(HERE, "unattended-digest.sh"), PROJECT], { encoding: "utf8" })
const out = digest.stdout || ""
const [fyiPart, actionPart = ""] = out.split("## ⚠️ Action needed")
check("7. digest prints the FYI section", out.includes("FYI (autonomous decisions)"))
check("7b. digest prints the Action needed section", out.includes("Action needed"))
check("7c. digest prints the Summary section", out.includes("## Summary"))
check("5. escalation appears under Action needed", actionPart.includes("deploy"))
check("5b. escalation is not listed under FYI", !fyiPart.includes("deploy"))

// 6. End of run (test #6)
fs.rmSync(activePath, { force: true })
prompts.length = 0
queue.push({ type: "session.idle", sessionID: "S1" })
await sleep(40)
check("6. sentinel removed -> no further nudges", prompts.length === 0)

// 8. Explicit off switch (added command)
if (hooks.prompt) {
  hooks.prompt({ sessionID: "S1", prompt: { text: "[[opencode-unattended:on]]" } })
  await sleep(10)
  const rearmed = fs.existsSync(activePath)
  hooks.prompt({ sessionID: "S1", prompt: { text: "[[opencode-unattended:off]]" } })
  await sleep(10)
  check("8. /unattended-off removes the sentinel", rearmed && !fs.existsSync(activePath))
}

cleanup?.()
check("plugin returns a cleanup function", typeof cleanup === "function")

console.log("──────────────────────────────────────────────────────────────")
console.log(`${pass} passed, ${fail} failed  (project: ${PROJECT})`)
process.exit(fail ? 1 : 0)
