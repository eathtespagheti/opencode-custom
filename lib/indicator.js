// The state machine behind the unattended indicator in the TUI.
//
// It keeps one entry per session: { armed, since } — or nothing at all when
// the state is unknown. "Unknown" is a first-class state here on purpose: the
// indicator must never claim that a session is *not* unattended just because
// the server could not be asked. The TUI renders nothing for an unknown
// session (see tui.jsx).
//
// This module is plain JavaScript on purpose: it holds the logic that matters
// and can be unit tested without a terminal. The TUI half only wires it to a
// Solid signal and to the sidebar slot.

/** Default backoff between retries while the server is not ready yet. */
export const DEFAULT_RETRY_DELAYS = [500, 2000, 5000]

// A status call must not hang forever: a client that keeps a request open
// would leave the badge in the unknown state without a word in the log.
export const DEFAULT_TIMEOUT_MS = 10_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Reject when the promise takes longer than `ms`. */
function withTimeout(promise, ms, what) {
  if (!ms || ms < 0) return promise
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
      if (typeof timer?.unref === "function") timer.unref()
    }),
  ])
}

/**
 * @param {object} options
 * @param {any} options.api The RPC subclient (may be undefined: then nothing
 *   is ever known and the indicator stays hidden).
 * @param {(msg: string) => void} [options.log]
 * @param {number[]} [options.retryDelays]
 * @param {number} [options.timeoutMs]
 */
export function createIndicator({
  api,
  log = () => {},
  retryDelays = DEFAULT_RETRY_DELAYS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // sessionID -> { armed, since }
  const known = new Map()
  // sessionID -> number of changes seen. Guards against a slow status answer
  // overwriting a newer event.
  const versions = new Map()
  // Sessions with a request in flight.
  const inFlight = new Set()
  const listeners = new Set()

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch { /* a broken listener must not break the indicator */ }
    }
  }

  const put = (sessionID, value) => {
    if (!sessionID) return
    versions.set(sessionID, (versions.get(sessionID) || 0) + 1)
    const prev = known.get(sessionID)
    if (prev && prev.armed === value.armed && prev.since === value.since) return
    known.set(sessionID, value)
    notify()
  }

  const forget = (sessionID) => {
    if (!sessionID || !known.has(sessionID)) return
    known.delete(sessionID)
    notify()
  }

  /** Ask the server for the current state of one session. */
  const refresh = async (sessionID) => {
    if (!api || !sessionID) return
    const startedAt = versions.get(sessionID) || 0
    try {
      const res = await withTimeout(api.status({ sessionID }), timeoutMs, `status ${sessionID}`)
      // A response we cannot read is not an "off": it is unknown.
      if (!res || typeof res.armed !== "boolean") {
        throw new Error(`unexpected status response: ${JSON.stringify(res)}`)
      }
      log(`status ${sessionID} -> ${JSON.stringify(res)}`)
      // A change arrived while we were asking: the event is newer, keep it.
      if ((versions.get(sessionID) || 0) !== startedAt) return
      put(sessionID, { armed: res.armed, since: res.since })
    } catch (err) {
      log(`status ${sessionID} failed: ${err}`)
      // A late answer to a timed-out request must not resurrect an old state.
      versions.set(sessionID, (versions.get(sessionID) || 0) + 1)
      // Unknown. Drop whatever we had so nothing misleading stays on screen.
      forget(sessionID)
    }
  }

  /** Fetch, and retry a few times while the server is not ready yet. */
  const refreshWithRetry = async (sessionID) => {
    if (!api || !sessionID || inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        await refresh(sessionID)
        if (known.has(sessionID)) return
        if (attempt < retryDelays.length) await sleep(retryDelays[attempt])
      }
    } finally {
      inFlight.delete(sessionID)
    }
  }

  /** Apply a "changed" event from the server. */
  const applyEvent = (data) => {
    if (!data?.sessionID) return
    // An event we cannot read says nothing about the state: ignore it.
    if (typeof data.armed !== "boolean") {
      log(`event changed ignored: ${JSON.stringify(data)}`)
      return
    }
    log(`event changed: ${JSON.stringify(data)}`)
    put(data.sessionID, { armed: data.armed, since: data.since })
  }

  /** Listen to the server's change events. Returns an unsubscribe function. */
  const start = () => {
    if (!api?.events?.on) return () => {}
    const stop = api.events.on("changed", (event) => applyEvent(event?.data))
    return typeof stop === "function" ? stop : () => {}
  }

  return {
    /** The known state of a session, or undefined when it is unknown. */
    get: (sessionID) => known.get(sessionID),
    /** True when the state of a session is known. */
    isKnown: (sessionID) => known.has(sessionID),
    /** Subscribe to state changes; returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    refreshWithRetry,
    applyEvent,
    start,
  }
}
