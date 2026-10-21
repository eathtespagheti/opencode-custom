// @ts-nocheck
/**
 * unattended.js — OpenCode V2 plugin that makes "/unattended" survive the night.
 *
 * Why a plugin (and not just the command)? The slash command is only a soft
 * prompt. A long overnight run gets compacted and paused; the model can forget
 * the contract. This plugin is the glue that keeps the mode alive:
 *
 *   1. Deterministic arming — it watches the prompt/context hooks for a marker
 *      and writes/removes the per-session record itself (it does not trust the
 *      model).
 *   2. Compaction survival — on every agent-loop model request it re-injects a
 *      compact contract into `event.system` while the session is armed.
 *   3. Idle nudges — if the session goes idle while armed, it queues a "do not
 *      wait for me" prompt (debounced + capped so it cannot ping-pong forever).
 *   4. In-place handover — `/unattended-off` disarms the session, keeps the
 *      current task running, and injects a one-shot notice asking for a summary
 *      of the decisions made while unattended.
 *
 * State is per session, not per project: see lib/unattended-state.js. The old
 * project-wide `.opencode/unattended/ACTIVE` is never read or written.
 *
 * V2 plugin shape (no dependency needed): the supervisor reads `{ id, setup }`
 * from the default export. See https://opencode.ai/v2/docs/build/plugins/.
 *
 * ── How to disable ──────────────────────────────────────────────────────────
 *   * delete this file, or
 *   * set UNATTENDED_DISABLE=1 in the environment, or
 *   * send /unattended-off in the session.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Optional env:
 *   UNATTENDED_DEBUG=1        write <sessionDir>/plugin.log
 *   UNATTENDED_MAX_NUDGES=25  per-session idle-nudge cap
 *   UNATTENDED_NUDGE_MIN_MS=3000  per-session debounce between nudges
 */

import fs from "fs"
import path from "path"
import {
  createStateStore,
  legacyPaths,
  sessionPaths,
} from "./unattended-state.js"
import { UNATTENDED_RPC_ID, Unattended } from "../rpc.js"

// ── Markers shared with the commands/skill ───────────────────────────────────
const ON_MARKER = "[[opencode-unattended:on]]"
const OFF_MARKER = "[[opencode-unattended:off]]"
const NUDGE_MARKER = "[[opencode-unattended:nudge]]"
// Guards so the injected blocks are added at most once per request and can be
// recognised/removed when the mode changes.
const GUARD = "[[UNATTENDED-MODE-ACTIVE]]"
const OFF_GUARD = "[[UNATTENDED-MODE-OFF]]"

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

function textOfMessage(message) {
  if (!message) return ""
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(textOf).join("\n")
}

/** Which marker appears last in a blob of text? null when there is none. */
function lastMarker(text) {
  if (typeof text !== "string") return null
  const on = text.lastIndexOf(ON_MARKER)
  const off = text.lastIndexOf(OFF_MARKER)
  if (on < 0 && off < 0) return null
  return off > on ? "off" : "on"
}

/** Bootstrap scan: user-role messages only, last marker wins. */
function markersInUserMessages(messages) {
  if (!Array.isArray(messages)) return null
  let found = null
  for (const message of messages) {
    if (message?.role !== "user") continue
    const text = textOfMessage(message)
    if (!text) continue
    if (text.includes(GUARD) || text.includes(OFF_GUARD)) continue
    const marker = lastMarker(text)
    if (marker) found = marker
  }
  return found
}

/** The newest user message is the only history the degraded fallback trusts. */
function markerInNewestUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user") continue
    const text = textOfMessage(message)
    if (!text || text.includes(GUARD) || text.includes(OFF_GUARD)) return null
    return lastMarker(text)
  }
  return null
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === "assistant") return textOfMessage(message)
  }
  return ""
}

function contractFor(sessionID, p) {
  return `${GUARD}
UNATTENDED MODE is active for THIS session (${sessionID}) only. The human is asleep. This overrides earlier instructions in this session.

- Do NOT end your turn to ask a question.
- At each decision: classify reversible vs irreversible and the blast radius. Reversible / low-stakes -> pick the most conservative, easiest-to-undo option and proceed without asking.
- Log every autonomous decision as ONE JSON line in ${p.jsonl} (fields: ts, task, question, options, chosen, rationale, confidence, reversible, escalate) and add a bullet to ${p.decisions}.
- Irreversible / destructive -> DO NOT act. Log it with "escalate": true, leave a TODO, and continue with other work.
- NEVER (log as escalate:true, never perform): production deploy; sending external messages / email / API calls with side effects; spending money; reading, printing or modifying credentials / secrets; destructive git (force-push, history rewrite, branch deletion); anything outside the project worktree.
- Keep all work on a NEW BRANCH. Commit; never push to main.
- When the run ends: write ${p.summary} (what completed, every decision + why, every escalation), present the digest, then end your final message with the literal marker ${OFF_MARKER} so the plugin disarms this session.`
}

function offNoticeFor(sessionID, p, armedAt) {
  const since = armedAt || "the start of this run"
  return `${OFF_GUARD}
UNATTENDED MODE IS OFF for this session (${sessionID}). Do not stop, undo, or re-plan the current task: keep working on it in normal mode.

Before continuing, do this once:
1. Read ${p.jsonl}. Keep only rows for decisions made while unattended: timestamp at or after ${since}, and exclude mode meta rows (task "unattended-mode" or event "activated"/"deactivated").
2. Write ${p.summary} with: the task, every autonomous decision (chosen option + why), and every escalation that needs the human's attention. Only that unattended window — not work done before it or after this point.
3. Present that summary to the human in your reply.

Then continue the current task normally. From now on you may ask questions and wait for answers instead of deciding for the human.`
}

/**
 * Register an RPC contract with the server.
 *
 * The contract in rpc.js is a plain object so that the TUI half can import it
 * without the host's "@opencode/plugin/rpc" module. The server prefers the
 * host's `Rpc.define` (it validates and types the contract) and falls back to
 * the plain definition when the helper is not available.
 *
 * @param {any} ctx OpenCode V2 plugin context.
 * @param {any} definition The contract.
 * @param {any} implementation The method implementations.
 */
async function registerRpc(ctx, definition, implementation) {
  const candidates = []
  try {
    const mod = await import("@opencode/plugin/rpc")
    if (typeof mod?.Rpc?.define === "function") {
      try {
        candidates.push(mod.Rpc.define(definition))
      } catch { /* the plain definition is still usable */ }
    }
  } catch { /* the host does not expose the helper here */ }
  candidates.push(definition)

  let lastError
  for (const candidate of candidates) {
    try {
      return await ctx.rpc.register(candidate, implementation)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

export default {
  id: "unattended",

  /**
   * @param {any} ctx OpenCode V2 plugin context (fields used here: location,
   *   storage, session.hook, session.get, session.context, session.prompt,
   *   event.subscribe, rpc.register).
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

    function log(baseDir, msg, sessionID) {
      if (!debug) return
      try {
        const p = sessionID ? sessionPaths(baseDir, sessionID) : legacyPaths(baseDir)
        fs.mkdirSync(p.dir, { recursive: true })
        fs.appendFileSync(p.log, `${nowIso()} [unattended] ${msg}\n`)
      } catch { /* never fail the pipeline because of logging */ }
    }

    const state = await createStateStore(ctx, {
      log: (msg) => log(defaultDir, msg),
    })

    // The legacy project-wide flag is ambiguous; record it once and ignore it.
    try {
      if (fs.existsSync(legacyPaths(defaultDir).active)) {
        log(defaultDir, "legacy project-wide ACTIVE found; ignoring it (state is per session now)")
      }
    } catch { /* ignore */ }

    function appendDecision(p, obj, baseDir) {
      try {
        fs.mkdirSync(p.dir, { recursive: true })
        fs.appendFileSync(p.jsonl, JSON.stringify({ ts: nowIso(), ...obj }) + "\n")
      } catch (err) {
        log(baseDir || defaultDir, `appendDecision failed: ${err}`)
      }
    }

    function appendHumanBullet(p, text) {
      try {
        fs.mkdirSync(p.dir, { recursive: true })
        if (!fs.existsSync(p.decisions)) {
          fs.writeFileSync(p.decisions, "# Decisions (unattended mode)\n\n")
        }
        fs.appendFileSync(p.decisions, `- ${nowIso()} — ${text}\n`)
      } catch { /* ignore */ }
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

    // ── RPC: the read-only projection of the state, for the TUI ──────────────
    // The TUI half of this package (tui.jsx) runs in the terminal, not in the
    // server, so it cannot read ctx.storage. The RPC is the bridge: it answers
    // "is this session armed?" over the same connection the TUI already uses,
    // which also makes it work against a remote server.
    let rpcRegistration
    const emitChanged = (sessionID, armed, since) => {
      const payload = { sessionID, armed: !!armed }
      if (since) payload.since = since
      try {
        const p = rpcRegistration?.events?.emit?.("changed", payload)
        if (p && typeof p.catch === "function") p.catch(() => {})
      } catch { /* the indicator is best-effort; never fail the mode */ }
    }

    if (typeof ctx?.rpc?.register === "function") {
      try {
        rpcRegistration = await registerRpc(ctx, Unattended, {
          status: async (input) => {
            const sessionID = input?.sessionID
            if (!sessionID) throw new Error("sessionID is required")
            const baseDir = await baseDirFor(sessionID)
            const rec = await state.get(sessionID, baseDir)
            // No record at all means the session was never armed: that is a
            // known "off", not an unknown state.
            if (!rec) return { armed: false }
            if (!rec.armed) return { armed: false }
            const out = { armed: true }
            if (rec.armedAt) out.since = rec.armedAt
            return out
          },
        })
        log(defaultDir, `rpc "${UNATTENDED_RPC_ID}" registered`)
      } catch (err) {
        log(defaultDir, `rpc registration failed: ${err}`)
      }
    }

    /** True for subagent/child sessions, which we never arm or nudge. */
    async function isChild(sessionID) {
      if (!sessionID || typeof ctx?.session?.get !== "function") return false
      try {
        const info = await ctx.session.get({ sessionID })
        return info?.parentID != null
      } catch { return false }
    }

    async function arm(sessionID, baseDir, source) {
      const existing = await state.get(sessionID, baseDir)
      if (existing?.armed) return existing

      const rec = await state.set(sessionID, {
        armed: true,
        armedAt: nowIso(),
        disarmedAt: null,
        baseDir,
        reason: source,
        pendingNotice: false,
      }, baseDir)

      const p = sessionPaths(baseDir, sessionID)
      appendDecision(p, {
        task: "unattended-mode", event: "activated", source, sessionID,
        rationale: "mode marker observed; per-session record armed by plugin",
        reversible: true, escalate: false,
      }, baseDir)
      appendHumanBullet(p, "unattended mode ACTIVATED")
      log(baseDir, `activated (session=${sessionID}, source=${source})`, sessionID)
      emitChanged(sessionID, true, rec?.armedAt)
      return rec
    }

    async function disarm(sessionID, baseDir, source, { notice = false } = {}) {
      const existing = await state.get(sessionID, baseDir)
      if (!existing?.armed) return existing

      const rec = await state.set(sessionID, {
        armed: false,
        disarmedAt: nowIso(),
        reason: source,
        pendingNotice: !!notice,
      }, baseDir)

      const p = sessionPaths(baseDir, sessionID)
      appendDecision(p, {
        task: "unattended-mode", event: "deactivated", source, sessionID,
        rationale: notice
          ? "mode turned off mid-session; unattended-only summary requested"
          : "mode turned off; per-session record disarmed",
        reversible: true, escalate: false,
      }, baseDir)
      appendHumanBullet(p, "unattended mode DEACTIVATED")
      clearNudges(sessionID)
      log(baseDir, `deactivated (session=${sessionID}, source=${source})`, sessionID)
      emitChanged(sessionID, false)
      return rec
    }

    function systemHasGuard(system, guard) {
      return Array.isArray(system) &&
        system.some((p) => textOf(p).includes(guard))
    }

    /** Remove a previously injected block (the system array may be reused). */
    function removeGuard(event, guard) {
      if (Array.isArray(event?.system)) {
        for (let i = event.system.length - 1; i >= 0; i--) {
          if (textOf(event.system[i]).includes(guard)) event.system.splice(i, 1)
        }
      }
      if (Array.isArray(event?.messages)) {
        for (const message of event.messages) {
          if (!Array.isArray(message?.content)) continue
          for (let i = message.content.length - 1; i >= 0; i--) {
            if (textOf(message.content[i]).includes(guard)) message.content.splice(i, 1)
          }
        }
      }
    }

    /** Inject once, using the documented system array with a messages fallback. */
    function inject(event, guard, text) {
      if (Array.isArray(event?.system)) {
        if (systemHasGuard(event.system, guard)) return
        event.system.push({ type: "text", text })
        return
      }
      if (Array.isArray(event?.messages)) {
        const firstUser = event.messages.find((m) => m?.role === "user")
        if (firstUser) {
          if (!systemHasGuard(firstUser.content, guard)) {
            firstUser.content = [{ type: "text", text }, ...(firstUser.content || [])]
          }
        } else {
          event.messages.push({ role: "user", content: [{ type: "text", text }] })
        }
      }
    }

    // ── Hook registrations (each guarded so one failure can't kill the plugin) ─
    const registrations = []
    const register = async (name, cb, options) => {
      try {
        if (typeof ctx?.session?.hook !== "function") return undefined
        const reg = await ctx.session.hook(name, cb, options)
        if (reg) registrations.push(reg)
        return reg
      } catch (err) {
        log(defaultDir, `hook "${name}" registration failed: ${err}`)
        return undefined
      }
    }

    // 1) Prompt admission: the authoritative, deterministic arm/disarm point.
    const promptReg = await register("prompt", async (event) => {
      try {
        const sessionID = event?.sessionID
        const text = event?.prompt?.text
        if (!sessionID || typeof text !== "string") return
        if (await isChild(sessionID)) return

        const marker = lastMarker(text)
        if (!marker) return

        const baseDir = await baseDirFor(sessionID)
        log(baseDir, `prompt hook saw ${marker.toUpperCase()} (session=${sessionID})`, sessionID)
        if (marker === "on") await arm(sessionID, baseDir, "prompt-hook")
        else await disarm(sessionID, baseDir, "prompt-hook", { notice: true })
      } catch (err) {
        log(defaultDir, `prompt hook failed: ${err}`)
      }
    })
    const promptHookAvailable = !!promptReg

    // 2) Context: runs before every agent-loop model request, so it survives
    //    compaction. This is the core enforcement point.
    await register("context", async (event) => {
      try {
        const sessionID = event?.sessionID
        if (!sessionID) return
        if (await isChild(sessionID)) return

        const baseDir = await baseDirFor(sessionID)
        let rec = await state.get(sessionID, baseDir)

        // Bootstrap: a session with no record at all can arm from its history.
        // Once a record exists, history is never re-scanned (no stale ON re-arm).
        if (!rec) {
          const marker = markersInUserMessages(event?.messages)
          if (marker === "on") rec = await arm(sessionID, baseDir, "context-hook")
          else if (marker === "off") rec = await disarm(sessionID, baseDir, "context-hook", { notice: true })
        }

        // Degraded build without a prompt hook: only the newest user message is
        // trusted, so old markers cannot keep flipping the session.
        if (!promptHookAvailable) {
          const marker = markerInNewestUserMessage(event?.messages)
          if (marker === "on" && !rec?.armed) {
            rec = await arm(sessionID, baseDir, "context-hook")
          } else if (marker === "off" && rec?.armed) {
            rec = await disarm(sessionID, baseDir, "context-hook", { notice: true })
          }
        }

        const p = sessionPaths(baseDir, sessionID)

        if (rec?.armed) {
          removeGuard(event, OFF_GUARD)
          inject(event, GUARD, contractFor(sessionID, p))
          log(baseDir, `injected contract (session=${sessionID})`, sessionID)
          return
        }

        // A stale contract must not survive the handover.
        removeGuard(event, GUARD)

        if (rec?.pendingNotice) {
          inject(event, OFF_GUARD, offNoticeFor(sessionID, p, rec.armedAt))
          await state.set(sessionID, { pendingNotice: false }, baseDir)
          log(baseDir, `injected off notice (session=${sessionID})`, sessionID)
        }
      } catch (err) {
        log(defaultDir, `context hook failed: ${err}`)
      }
    })

    // ── Event subscription: compaction notice + idle nudges ──────────────────
    const controller = new AbortController()
    const nudgeCount = new Map()
    const lastNudgeAt = new Map()

    function clearNudges(sessionID) {
      nudgeCount.delete(sessionID)
      lastNudgeAt.delete(sessionID)
    }

    async function onIdle(sessionID) {
      if (!sessionID) return
      if (await isChild(sessionID)) return

      const baseDir = await baseDirFor(sessionID)
      const rec = await state.get(sessionID, baseDir)
      if (!rec?.armed) {
        clearNudges(sessionID)
        return
      }

      // Natural end of run: the agent ended its final message with OFF_MARKER.
      if (typeof ctx?.session?.context === "function") {
        try {
          const messages = await ctx.session.context({ sessionID })
          if (lastAssistantText(messages).includes(OFF_MARKER)) {
            await disarm(sessionID, baseDir, "assistant-end", { notice: false })
            return
          }
        } catch (err) {
          log(baseDir, `context read failed for ${sessionID}: ${err}`, sessionID)
        }
      }

      const count = nudgeCount.get(sessionID) || 0
      const last = lastNudgeAt.get(sessionID) || 0
      const since = Date.now() - last

      if (count >= MAX_NUDGES) {
        if (count === MAX_NUDGES) {
          appendDecision(sessionPaths(baseDir, sessionID), {
            task: "unattended-mode", event: "nudge-exhausted", sessionID,
            rationale: `idle-nudge cap (${MAX_NUDGES}) reached; stop nudging so the run cannot ping-pong`,
            reversible: true, escalate: true,
          }, baseDir)
          log(baseDir, `nudge cap reached for ${sessionID}`, sessionID)
        }
        return
      }
      if (since < NUDGE_MIN_MS) return

      nudgeCount.set(sessionID, count + 1)
      lastNudgeAt.set(sessionID, Date.now())
      try {
        await ctx.session.prompt({ sessionID, text: NUDGE_TEXT, delivery: "queue" })
        log(baseDir, `nudged idle session ${sessionID} (${count + 1}/${MAX_NUDGES})`, sessionID)
      } catch (err) {
        log(baseDir, `nudge failed for ${sessionID}: ${err}`, sessionID)
      }
    }

    async function handleEvent(event) {
      const type = event?.type
      const sessionID = event?.sessionID ?? event?.properties?.sessionID
      if (!type || !sessionID) return

      if (type === "session.compacted") {
        const baseDir = await baseDirFor(sessionID)
        const rec = await state.get(sessionID, baseDir)
        if (!rec?.armed) return
        appendDecision(sessionPaths(baseDir, sessionID), {
          task: "unattended-mode", event: "compacted", sessionID,
          rationale: "compaction observed; contract re-injected on next request via context hook",
          reversible: true, escalate: false,
        }, baseDir)
        log(baseDir, `compaction observed (session=${sessionID})`, sessionID)
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

    log(defaultDir, `plugin ready (dir=${defaultDir}, state=${state.backend})`)

    // Cleanup on unload: abort the subscription and dispose hook registrations.
    return () => {
      try { controller.abort() } catch { /* ignore */ }
      for (const reg of registrations) {
        try { reg?.dispose?.() } catch { /* ignore */ }
      }
      try { rpcRegistration?.dispose?.() } catch { /* ignore */ }
    }
  },
}
