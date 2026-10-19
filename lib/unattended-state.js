// Per-session state and artifact paths for unattended mode.
//
// One record per session, keyed by session ID. The record answers one question:
// "is unattended mode on for THIS session?" It is deliberately independent of
// the project directory, so two sessions in the same project never share it.
//
// Backend selection happens once, at createStateStore():
//   * ctx.storage (durable plugin-scoped JSON) when the hydrate scan works;
//   * otherwise per-session files under
//     <baseDir>/.opencode/unattended/sessions/<sessionID>/.
// It never switches mid-run: two backends would mean two divergent records.
//
// The project-wide <baseDir>/.opencode/unattended/ACTIVE is never read or
// written here. It belongs to the pre-per-session design and is ambiguous.

import fs from "fs"
import path from "path"

export const SESSION_PREFIX = "unattended/session/"

/** Session IDs are already `ses_…`; sanitize anyway so they are safe as paths. */
export function sanitizeSessionID(sessionID) {
  return String(sessionID).replace(/[^A-Za-z0-9._-]/g, "_")
}

/** Artifact paths for one session, rooted at the project directory. */
export function sessionPaths(baseDir, sessionID) {
  const dir = path.join(
    baseDir,
    ".opencode",
    "unattended",
    "sessions",
    sanitizeSessionID(sessionID),
  )
  return {
    dir,
    active: path.join(dir, "ACTIVE"),
    record: path.join(dir, "record.json"),
    jsonl: path.join(dir, "decisions.jsonl"),
    decisions: path.join(dir, "DECISIONS.md"),
    summary: path.join(dir, "SUMMARY.md"),
    log: path.join(dir, "plugin.log"),
  }
}

/** The pre-per-session layout, used only for detection and digest fallback. */
export function legacyPaths(baseDir) {
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

function asRecord(key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const sessionID = typeof value.sessionID === "string" && value.sessionID
    ? value.sessionID
    : key.slice(SESSION_PREFIX.length)
  if (!sessionID) return undefined
  return { ...value, sessionID }
}

function readFileRecord(p) {
  try {
    if (!fs.existsSync(p.record)) return undefined
    return JSON.parse(fs.readFileSync(p.record, "utf8"))
  } catch {
    return undefined
  }
}

function fileIsArmed(p) {
  try { return fs.existsSync(p.active) } catch { return false }
}

/**
 * @param {any} ctx OpenCode V2 plugin context (only `storage` is used).
 * @param {{ log?: (msg: string) => void }} options
 */
export async function createStateStore(ctx, { log = () => {} } = {}) {
  const records = new Map()
  let backend = "files"

  if (ctx?.storage && typeof ctx.storage.scan === "function" && typeof ctx.storage.set === "function") {
    try {
      let after
      do {
        const page = await ctx.storage.scan({
          prefix: SESSION_PREFIX,
          limit: 100,
          ...(after ? { after } : {}),
        })
        for (const entry of page?.entries || []) {
          const rec = asRecord(entry?.key || "", entry?.value)
          if (rec) records.set(rec.sessionID, rec)
        }
        after = page?.next
      } while (after)
      backend = "storage"
    } catch (err) {
      log(`storage hydrate failed; using per-session files: ${err}`)
    }
  }

  async function load(sessionID, baseDir) {
    if (!sessionID) return undefined
    if (records.has(sessionID)) return records.get(sessionID)
    if (backend !== "files" || !baseDir) return undefined

    const p = sessionPaths(baseDir, sessionID)
    const stored = readFileRecord(p)
    if (stored) {
      // An ACTIVE file without a record means "armed"; a record wins otherwise.
      const rec = { sessionID, ...stored }
      records.set(sessionID, rec)
      return rec
    }
    if (fileIsArmed(p)) {
      const rec = { sessionID, armed: true, armedAt: new Date().toISOString() }
      records.set(sessionID, rec)
      return rec
    }
    return undefined
  }

  async function persist(rec, baseDir) {
    if (backend === "storage") {
      try {
        await ctx.storage.set(SESSION_PREFIX + rec.sessionID, rec)
      } catch (err) {
        // Keep the in-memory record: the run is still correct for this process.
        log(`storage set failed for ${rec.sessionID}: ${err}`)
      }
      return
    }

    const dirBase = baseDir || rec.baseDir
    if (!dirBase) return
    const p = sessionPaths(dirBase, rec.sessionID)
    try {
      fs.mkdirSync(p.dir, { recursive: true })
      fs.writeFileSync(p.record, JSON.stringify(rec, null, 2) + "\n")
      if (rec.armed) {
        fs.writeFileSync(p.active, `${rec.armedAt || new Date().toISOString()}\n`)
      } else {
        fs.rmSync(p.active, { force: true })
      }
    } catch (err) {
      log(`file persist failed for ${rec.sessionID}: ${err}`)
    }
  }

  return {
    backend,
    async get(sessionID, baseDir) {
      return await load(sessionID, baseDir)
    },
    async isArmed(sessionID, baseDir) {
      const rec = await load(sessionID, baseDir)
      return !!rec?.armed
    },
    async set(sessionID, patch, baseDir) {
      const prev = (await load(sessionID, baseDir)) || { sessionID }
      const rec = {
        ...prev,
        ...patch,
        sessionID,
        updatedAt: new Date().toISOString(),
      }
      records.set(sessionID, rec)
      await persist(rec, baseDir)
      return rec
    },
  }
}
