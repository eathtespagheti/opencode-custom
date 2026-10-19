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
const FILE_PROJECT = "/tmp/opencode/unattended-selftest-file-project"

fs.rmSync(PROJECT, { recursive: true, force: true })
fs.rmSync(FILE_PROJECT, { recursive: true, force: true })
fs.mkdirSync(PROJECT, { recursive: true })
fs.mkdirSync(FILE_PROJECT, { recursive: true })

// A legacy project-wide flag must arm nobody.
fs.mkdirSync(path.join(PROJECT, ".opencode", "unattended"), { recursive: true })
fs.writeFileSync(path.join(PROJECT, ".opencode", "unattended", "ACTIVE"), "legacy\n")

process.env.UNATTENDED_DEBUG = "1"
process.env.UNATTENDED_NUDGE_MIN_MS = "100"
process.env.UNATTENDED_MAX_NUDGES = "3"

const { default: plugin } = await import(path.join(PKG_ROOT, "lib", "unattended.js"))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`) }
}

function makeCtx({ project, withStorage = true }) {
  const hooks = {}
  const prompts = []
  const storage = new Map()
  const queue = []
  const contexts = new Map()

  const ctx = {
    location: { directory: project },
    session: {
      hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} } },
      get: async ({ sessionID }) => ({ sessionID, parentID: undefined, directory: project }),
      context: async ({ sessionID }) => contexts.get(sessionID) || [],
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

  if (withStorage) {
    ctx.storage = {
      get: async (key) => storage.get(key),
      set: async (key, value) => { storage.set(key, structuredClone(value)) },
      remove: async (key) => { storage.delete(key) },
      scan: async ({ prefix }) => ({
        entries: [...storage.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    }
  }

  const record = (sessionID) => storage.get(`unattended/session/${sessionID}`)
  return { ctx, hooks, prompts, storage, queue, contexts, record }
}

const main = makeCtx({ project: PROJECT })
const cleanup = await plugin.setup(main.ctx)
const { hooks, prompts, queue, contexts } = main
const sessionDir = (sessionID) =>
  path.join(PROJECT, ".opencode", "unattended", "sessions", sessionID)
const partsText = (parts) => parts.map((p) => String(p?.text ?? "")).join("\n")

console.log("── Acceptance tests ─────────────────────────────────────────")

// 1. Arming (session-scoped)
check("plugin registered the context hook", typeof hooks.context === "function")
check("plugin registered the prompt hook", typeof hooks.prompt === "function")
await hooks.prompt({ sessionID: "S1", prompt: { text: "I'm going to bed — [[opencode-unattended:on]]" } })
await sleep(10)
check("1. /unattended arms the session", main.record("S1")?.armed === true)
check("1b. legacy project-wide ACTIVE is untouched",
  fs.existsSync(path.join(PROJECT, ".opencode", "unattended", "ACTIVE")))

// 2. Isolation in one project
const s2System = []
await hooks.context({ sessionID: "S2", system: s2System, messages: [] })
check("2. a sibling session gets no contract", !partsText(s2System).includes("[[UNATTENDED-MODE-ACTIVE]]"))
check("2b. a sibling session is not armed", main.record("S2") === undefined)

// 3. Compaction survival
const ctxEvent = { sessionID: "S1", system: [], messages: [{ role: "user", content: [{ type: "text", text: "keep going" }] }] }
queue.push({ type: "session.compacted", sessionID: "S1" })
await sleep(40)
await hooks.context(ctxEvent)
const guardCount = () => ctxEvent.system.filter((p) => String(p?.text || "").includes("[[UNATTENDED-MODE-ACTIVE]]")).length
check("3. contract injected into event.system after compaction", guardCount() === 1, JSON.stringify(ctxEvent.system))
await hooks.context(ctxEvent)
check("3b. re-injection is deduplicated", guardCount() === 1)
check("3c. contract carries the session's absolute paths",
  partsText(ctxEvent.system).includes(path.join(sessionDir("S1"), "decisions.jsonl")))

// 4. Idle nudge + debounce + cap
prompts.length = 0
queue.push({ type: "session.idle", sessionID: "S1" })
queue.push({ type: "session.idle", sessionID: "S1" })
await sleep(60)
check("4. idle produces a nudge", prompts.length === 1, "prompts=" + prompts.length)
check("4b. nudge is debounced (burst -> one)", prompts.length === 1, "prompts=" + prompts.length)
check("4c. nudge carries the nudge marker", String(prompts[0]?.text || "").includes("[[opencode-unattended:nudge]]"))
check("4d. nudge delivery is queue", prompts[0]?.delivery === "queue")
for (let i = 0; i < 4; i++) { await sleep(160); queue.push({ type: "session.idle", sessionID: "S1" }) }
await sleep(220)
check("4e. idle-nudge cap is respected (max 3)", prompts.length === 3, "prompts=" + prompts.length)

// 5. Per-session decision log
const jsonlPath = path.join(sessionDir("S1"), "decisions.jsonl")
const jsonl = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf8") : ""
check("5. decisions.jsonl records activation with rationale", jsonl.includes('"event":"activated"') && jsonl.includes('"rationale"'))
check("5b. decisions.jsonl is in the session directory", jsonlPath.includes(path.join("sessions", "S1")))

// 6. Mid-session off: disarm, keep running, write the summary notice once
await hooks.prompt({ sessionID: "S1", prompt: { text: "take over [[opencode-unattended:off]]" } })
await sleep(10)
check("6. off disarms the session", main.record("S1")?.armed === false)
check("6b. off requests the summary", main.record("S1")?.pendingNotice === true)
const offSystem = []
await hooks.context({ sessionID: "S1", system: offSystem, messages: [] })
const offText = partsText(offSystem)
check("6c. off notice is injected once", offText.includes("[[UNATTENDED-MODE-OFF]]"))
check("6d. off notice bounds the summary at armedAt", offText.includes(main.record("S1")?.armedAt))
check("6e. off notice carries the summary path", offText.includes(path.join(sessionDir("S1"), "SUMMARY.md")))
check("6f. contract is removed on handover", !offText.includes("[[UNATTENDED-MODE-ACTIVE]]"))
const offAgain = []
await hooks.context({ sessionID: "S1", system: offAgain, messages: [] })
check("6g. off notice is not repeated", !partsText(offAgain).includes("[[UNATTENDED-MODE-OFF]]"))
check("6h. sibling session stayed unarmed", main.record("S2") === undefined)

// 7. Escalation + digest scoped to the session
fs.appendFileSync(jsonlPath, JSON.stringify({
  ts: new Date().toISOString(), task: "deploy", question: "push to prod?",
  options: ["yes", "no"], chosen: "no", rationale: "irreversible — escalated, not performed",
  reversible: false, escalate: true,
}) + "\n")
fs.writeFileSync(path.join(sessionDir("S1"), "SUMMARY.md"), "# Summary\n\n- did things\n- 1 escalation\n")
const digest = spawnSync("bash", [path.join(HERE, "unattended-digest.sh"), "--session", "S1", PROJECT], { encoding: "utf8" })
const out = digest.stdout || ""
const [fyiPart, actionPart = ""] = out.split("## ⚠️ Action needed")
check("7. digest prints the FYI section", out.includes("FYI (autonomous decisions)"))
check("7b. digest prints the Action needed section", out.includes("Action needed"))
check("7c. digest prints the Summary section", out.includes("## Summary"))
check("7d. digest reads the session directory", !out.includes("legacy"))
check("7e. escalation appears under Action needed", actionPart.includes("deploy"))
check("7f. escalation is not listed under FYI", !fyiPart.includes("deploy"))

// 8. Natural end of run: the assistant's marker disarms silently
await hooks.prompt({ sessionID: "S3", prompt: { text: "[[opencode-unattended:on]]" } })
contexts.set("S3", [
  { role: "assistant", content: [{ type: "text", text: "all done [[opencode-unattended:off]]" }] },
])
prompts.length = 0
queue.push({ type: "session.idle", sessionID: "S3" })
await sleep(80)
check("8. end marker disarms the session", main.record("S3")?.armed === false)
check("8b. end marker does not request a summary", main.record("S3")?.pendingNotice !== true)
check("8c. end marker suppresses the nudge", prompts.length === 0, "prompts=" + prompts.length)

// 9. File fallback (no ctx.storage): still per-session
const fallback = makeCtx({ project: FILE_PROJECT, withStorage: false })
const fallbackCleanup = await plugin.setup(fallback.ctx)
await fallback.hooks.prompt({ sessionID: "F1", prompt: { text: "[[opencode-unattended:on]]" } })
await fallback.hooks.prompt({ sessionID: "F2", prompt: { text: "[[opencode-unattended:on]]" } })
await fallback.hooks.prompt({ sessionID: "F1", prompt: { text: "[[opencode-unattended:off]]" } })
const f1 = path.join(FILE_PROJECT, ".opencode", "unattended", "sessions", "F1")
const f2 = path.join(FILE_PROJECT, ".opencode", "unattended", "sessions", "F2")
check("9. file fallback writes per-session records", fs.existsSync(path.join(f1, "record.json")) && fs.existsSync(path.join(f2, "record.json")))
check("9b. off in F1 only removes F1's ACTIVE", !fs.existsSync(path.join(f1, "ACTIVE")) && fs.existsSync(path.join(f2, "ACTIVE")))
const f2System = []
await fallback.hooks.context({ sessionID: "F2", system: f2System, messages: [] })
check("9c. F2 stays armed and receives the contract", partsText(f2System).includes("[[UNATTENDED-MODE-ACTIVE]]"))
check("9d. the project-wide sentinel is never written", !fs.existsSync(path.join(FILE_PROJECT, ".opencode", "unattended", "ACTIVE")))
fallbackCleanup?.()

cleanup?.()
check("plugin returns a cleanup function", typeof cleanup === "function")

console.log("──────────────────────────────────────────────────────────────")
console.log(`${pass} passed, ${fail} failed  (project: ${PROJECT})`)
process.exit(fail ? 1 : 0)
