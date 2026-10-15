// @ts-nocheck
/**
 * unattended.js — OpenCode V2 plugin that makes "/unattended" survive the night.
 *
 * Why a plugin (and not just the command)? The slash command is only a soft
 * prompt. A long overnight run gets compacted and paused; the model can forget
 * the contract. This plugin is the glue that keeps the mode alive:
 *
 *   1. Deterministic arming — it watches the prompt/context hooks for a marker
 *      and writes/removes the sentinel itself (it does not trust the model).
 *   2. Compaction survival — on every agent-loop model request it re-injects a
 *      compact contract into `event.system` while the sentinel exists. Because
 *      that runs per request (including right after a compaction), the contract
 *      cannot be silently lost.
 *   3. Idle nudges — if the session goes idle while the sentinel exists, it
 *      queues a "do not wait for me" prompt (debounced + capped so it cannot
 *      ping-pong forever).
 *
 * V2 plugin shape (no dependency needed): the supervisor reads `{ id, setup }`
 * from the default export. See https://opencode.ai/v2/docs/build/plugins/.
 *
 * ── How to disable ──────────────────────────────────────────────────────────
 *   * delete this file, or
 *   * set UNATTENDED_DISABLE=1 in the environment, or
 *   * remove the sentinel:  rm <project>/.opencode/unattended/ACTIVE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Optional env:
 *   UNATTENDED_DEBUG=1        write <project>/.opencode/unattended/plugin.log
 *   UNATTENDED_MAX_NUDGES=25  per-session idle-nudge cap
 *   UNATTENDED_NUDGE_MIN_MS=3000  per-session debounce between nudges
 */

import fs from "fs"
import path from "path"

// ── Markers shared with the commands/skill ───────────────────────────────────
const ON_MARKER = "[[opencode-unattended:on]]"
const OFF_MARKER = "[[opencode-unattended:off]]"
const NUDGE_MARKER = "[[opencode-unattended:nudge]]"
// Guard so the injected contract is added at most once per request.
const GUARD = "[[UNATTENDED-MODE-ACTIVE]]"

const COMPACT_CONTRACT = `${GUARD}
UNATTENDED MODE is active for this session. The human is asleep. This overrides earlier instructions in this session.

- Do NOT end your turn to ask a question.
- At each decision: classify reversible vs irreversible and the blast radius. Reversible / low-stakes -> pick the most conservative, easiest-to-undo option and proceed without asking.
- Log every autonomous decision as ONE JSON line in .opencode/unattended/decisions.jsonl (fields: ts, task, question, options, chosen, rationale, confidence, reversible, escalate) and add a bullet to DECISIONS.md.
- Irreversible / destructive -> DO NOT act. Log it with "escalate": true, leave a TODO, and continue with other work.
- NEVER (log as escalate:true, never perform): production deploy; sending external messages / email / API calls with side effects; spending money; reading, printing or modifying credentials / secrets; destructive git (force-push, history rewrite, branch deletion); anything outside the project worktree.
- Keep all work on a NEW BRANCH. Commit; never push to main.
- When the run ends: write .opencode/unattended/SUMMARY.md (what completed, every decision + why, every escalation), present the digest, then delete .opencode/unattended/ACTIVE.`

const NUDGE_TEXT = `${NUDGE_MARKER} Unattended mode: do not wait for me — decide conservatively, log it, continue. If blocked, log escalate:true and move on.`

// ── Small helpers ────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString()

function envInt(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Per-call collector for injected text that may live in `system` or `messages`. */
function textOf(entry) {
  if (!entry) return ""
  if (typeof entry === "string") return entry
  if (entry.type === "text" && typeof entry.text === "string") return entry.text
  if (typeof entry.content === "string") return entry.content
  return ""
}

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

export default {
  id: "unattended",

  /**
   * @param {any} ctx OpenCode V2 plugin context (fields used here: location,
   *   session.hook, session.get, session.prompt, event.subscribe).
   */
  async setup(ctx) {
    // Hard off switch.
    if (process.env.UNATTENDED_DISABLE === "1") return

    const debug = process.env.UNATTENDED_DEBUG === "1"
    const MAX_NUDGES = envInt("UNATTENDED_MAX_NUDGES", 25)
    const NUDGE_MIN_MS = envInt("UNATTENDED_NUDGE_MIN_MS", 3000)

    const defaultDir =
      ctx?.location?.directory ||
      ctx?.location?.project?.directory ||
      process.cwd()

    // ── Paths / state helpers ────────────────────────────────────────────────
    const paths = (baseDir) => {
      const dir = path.join(baseDir, ".opencode", "unattended")
      return {
        dir,
        active: path.join(dir, "ACTIVE"),
        jsonl: path.join(dir, "decisions.jsonl"),
        decisions: path.join(baseDir, "DECISIONS.md"),
        summary: path.join(dir, "SUMMARY.md"),
        log: path.join(dir, "plugin.log"),
      }
    }

    function log(baseDir, msg) {
      if (!debug) return
      try {
        const p = paths(baseDir)
        fs.mkdirSync(p.dir, { recursive: true })
        fs.appendFileSync(p.log, `${nowIso()} [unattended] ${msg}\n`)
      } catch { /* never fail the pipeline because of logging */ }
    }

    const isActive = (baseDir) => exists(paths(baseDir).active)

    function appendDecision(baseDir, obj) {
      try {
        const p = paths(baseDir)
        fs.mkdirSync(p.dir, { recursive: true })
        fs.appendFileSync(p.jsonl, JSON.stringify({ ts: nowIso(), ...obj }) + "\n")
      } catch (err) {
        log(baseDir, `appendDecision failed: ${err}`)
      }
    }

    function appendHumanBullet(baseDir, text) {
      try {
        const p = paths(baseDir)
        fs.mkdirSync(path.dirname(p.decisions), { recursive: true })
        if (!exists(p.decisions)) {
          fs.writeFileSync(p.decisions, "# Decisions (unattended mode)\n\n")
        }
        fs.appendFileSync(p.decisions, `- ${nowIso()} — ${text}\n`)
      } catch { /* ignore */ }
    }

    function activate(baseDir, source) {
      if (isActive(baseDir)) return
      try {
        const p = paths(baseDir)
        fs.mkdirSync(p.dir, { recursive: true })
        fs.writeFileSync(p.active, `${nowIso()}\n`)
        appendDecision(baseDir, {
          task: "unattended-mode", event: "activated", source,
          rationale: "mode marker observed; sentinel created by plugin",
          reversible: true, escalate: false,
        })
        appendHumanBullet(baseDir, "unattended mode ACTIVATED")
        log(baseDir, `activated (source=${source})`)
      } catch (err) {
        log(baseDir, `activate failed: ${err}`)
      }
    }

    function deactivate(baseDir, source) {
      if (!isActive(baseDir)) return
      try {
        const p = paths(baseDir)
        fs.rmSync(p.active, { force: true })
        appendDecision(baseDir, {
          task: "unattended-mode", event: "deactivated", source,
          rationale: "mode turned off; sentinel removed",
          reversible: true, escalate: false,
        })
        appendHumanBullet(baseDir, "unattended mode DEACTIVATED")
        log(baseDir, `deactivated (source=${source})`)
      } catch (err) {
        log(baseDir, `deactivate failed: ${err}`)
      }
    }

    /** Resolve the project directory for a session, falling back to the plugin location. */
    async function baseDirFor(sessionID) {
      if (sessionID && typeof ctx?.session?.get === "function") {
        try {
          const info = await ctx.session.get({ sessionID })
          const d = info?.directory || info?.project?.directory
          if (d) return d
        } catch { /* fall through */ }
      }
      return defaultDir
    }

    /** True for subagent/child sessions, which we never arm or nudge. */
    async function isChild(sessionID) {
      if (!sessionID || typeof ctx?.session?.get !== "function") return false
      try {
        const info = await ctx.session.get({ sessionID })
        return info?.parentID != null
      } catch { return false }
    }

    /** Scan a blob of text for arm/disarm markers and act deterministically. */
    function scanMarkers(baseDir, text, source) {
      if (typeof text !== "string" || text.length === 0) return
      if (text.includes(ON_MARKER)) activate(baseDir, source)
      if (text.includes(OFF_MARKER)) deactivate(baseDir, source)
    }

    /** Scan an array of hook messages (superpowers-style content parts) for markers. */
    function scanMessages(baseDir, messages, source) {
      if (!Array.isArray(messages)) return
      for (const m of messages) {
        if (!m) continue
        for (const part of Array.isArray(m.content) ? m.content : [m]) {
          scanMarkers(baseDir, textOf(part), source)
        }
      }
    }

    function systemHasGuard(system) {
      return Array.isArray(system) &&
        system.some((p) => textOf(p).includes(GUARD))
    }

    // ── Hook registrations (each guarded so one failure can't kill the plugin) ─
    const registrations = []
    const register = async (name, cb, options) => {
      try {
        if (typeof ctx?.session?.hook !== "function") return
        const reg = await ctx.session.hook(name, cb, options)
        if (reg) registrations.push(reg)
      } catch (err) {
        log(defaultDir, `hook "${name}" registration failed: ${err}`)
      }
    }

    // 1) Prompt admission: fastest, most deterministic place to arm/disarm.
    //    Not required for correctness — the context hook below also scans.
    await register("prompt", (event) => {
      try {
        const text = event?.prompt?.text
        const sessionID = event?.sessionID
        if (typeof text !== "string") return
        if (!text.includes(ON_MARKER) && !text.includes(OFF_MARKER)) return
        log(defaultDir, `prompt hook saw a marker (session=${sessionID})`)
        scanMarkers(defaultDir, text, "prompt-hook")
      } catch (err) {
        log(defaultDir, `prompt hook failed: ${err}`)
      }
    })

    // 2) Context: runs before every agent-loop model request, so it survives
    //    compaction. This is the core enforcement point.
    await register("context", async (event) => {
      try {
        const sessionID = event?.sessionID
        if (await isChild(sessionID)) return

        const baseDir = await baseDirFor(sessionID)

        // Fallback arming: if the prompt hook is unavailable on this build, the
        // command text is still visible here.
        if (!isActive(baseDir)) scanMessages(baseDir, event?.messages, "context-hook")
        if (!isActive(baseDir)) return

        if (Array.isArray(event?.system)) {
          if (!systemHasGuard(event.system)) {
            event.system.push({ type: "text", text: COMPACT_CONTRACT })
            log(baseDir, `injected contract into event.system (session=${sessionID})`)
          }
        } else if (Array.isArray(event?.messages)) {
          // Compatibility fallback (the superpowers pattern) when no system array.
          const firstUser = event.messages.find((m) => m?.role === "user")
          if (firstUser) {
            if (!systemHasGuard(firstUser.content)) {
              firstUser.content = [{ type: "text", text: COMPACT_CONTRACT }, ...(firstUser.content || [])]
            }
          } else {
            event.messages.push({ role: "user", content: [{ type: "text", text: COMPACT_CONTRACT }] })
          }
          log(baseDir, `injected contract into event.messages (session=${sessionID})`)
        }
      } catch (err) {
        log(defaultDir, `context hook failed: ${err}`)
      }
    })

    // ── Event subscription: compaction notice + idle nudges ──────────────────
    const controller = new AbortController()
    const nudgeCount = new Map()
    const lastNudgeAt = new Map()

    async function onIdle(sessionID) {
      const baseDir = await baseDirFor(sessionID)
      if (!isActive(baseDir)) return
      if (await isChild(sessionID)) return

      const count = nudgeCount.get(sessionID) || 0
      const last = lastNudgeAt.get(sessionID) || 0
      const since = Date.now() - last

      if (count >= MAX_NUDGES) {
        if (count === MAX_NUDGES) {
          appendDecision(baseDir, {
            task: "unattended-mode", event: "nudge-exhausted", sessionID,
            rationale: `idle-nudge cap (${MAX_NUDGES}) reached; stop nudging so the run cannot ping-pong`,
            reversible: true, escalate: true,
          })
          log(baseDir, `nudge cap reached for ${sessionID}`)
        }
        return
      }
      if (since < NUDGE_MIN_MS) return

      nudgeCount.set(sessionID, count + 1)
      lastNudgeAt.set(sessionID, Date.now())
      try {
        await ctx.session.prompt({ sessionID, text: NUDGE_TEXT, delivery: "queue" })
        log(baseDir, `nudged idle session ${sessionID} (${count + 1}/${MAX_NUDGES})`)
      } catch (err) {
        log(baseDir, `nudge failed for ${sessionID}: ${err}`)
      }
    }

    async function handleEvent(event) {
      const type = event?.type
      const sessionID = event?.sessionID ?? event?.properties?.sessionID
      if (!type) return

      if (type === "session.compacted") {
        const baseDir = await baseDirFor(sessionID)
        if (!isActive(baseDir)) return
        appendDecision(baseDir, {
          task: "unattended-mode", event: "compacted", sessionID,
          rationale: "compaction observed; contract re-injected on next request via context hook",
          reversible: true, escalate: false,
        })
        log(baseDir, `compaction observed (session=${sessionID}); context hook will re-inject`)
        return
      }

      if (type === "session.idle") {
        await onIdle(sessionID)
      }
    }

    if (typeof ctx?.event?.subscribe === "function") {
      ;(async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try { await handleEvent(event) } catch (err) { log(defaultDir, `event handler failed: ${err}`) }
          }
        } catch (err) {
          if (!controller.signal.aborted) log(defaultDir, `event subscription ended: ${err}`)
        }
      })()
    }

    log(defaultDir, `plugin ready (dir=${defaultDir})`)

    // Cleanup on unload: abort the subscription and dispose hook registrations.
    return () => {
      try { controller.abort() } catch { /* ignore */ }
      for (const reg of registrations) {
        try { reg?.dispose?.() } catch { /* ignore */ }
      }
    }
  },
}
