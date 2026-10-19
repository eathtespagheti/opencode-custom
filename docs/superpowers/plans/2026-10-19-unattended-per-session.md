# Unattended Per-Session State Implementation Plan

**Status:** implemented (2026-10-19)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unattended mode belong to one session and turn `/unattended-off` into an immediate handover that writes an unattended-only summary.

**Architecture:** A new `lib/unattended-state.js` owns the per-session record (durable `ctx.storage` keyed by session ID, with a per-session file fallback) and the per-session artifact paths. `lib/unattended.js` keeps the hooks, markers, contract/notice injection, nudges, and event handling. Commands, skill, digest, and docs follow the new layout.

**Tech Stack:** Plain ESM JavaScript, Node 22, `ctx.storage` / `ctx.session` V2 plugin APIs, bash + jq for the digest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-unattended-per-session-design.md`

## Global Constraints

- No new npm dependencies.
- Keep the plugin V2 shape (`export default { id, setup(ctx) }`).
- Never read or write the project-wide `.opencode/unattended/ACTIVE`.
- Every hook fails closed when `sessionID` is missing.
- Child sessions (`parentID != null`) never arm, receive the contract, or get nudged.
- State survives a plugin reload; the off notice survives a reload too.
- All paths written by the agent must be absolute and injected by the plugin.
- Existing tests must keep passing; run `npm test` after every task.

## Review Focus

- A stale `[[opencode-unattended:on]]` in history must never re-arm an explicitly disarmed session.
- The literal end marker documented in `SKILL.md` must never be scanned from tool/skill text.
- Two sessions in one project must never share armed state, nudges, or artifacts.
- A session moved with `session.move` must write new artifacts under its new directory.
- A storage failure must not create a second, divergent state backend mid-run.

---

### Task 1: Extract the state store

**Files:**
- Create: `lib/unattended-state.js`
- Test: `test/plugin.test.mjs` (storage mock added in Task 5; this task adds a direct smoke test)

**Interfaces:**
- `SESSION_PREFIX = "unattended/session/"`
- `sanitizeSessionID(id: string): string`
- `sessionPaths(baseDir: string, sessionID: string): { dir, active, record, jsonl, decisions, summary, log }`
- `legacyPaths(baseDir: string): { dir, active, jsonl, decisions, log }`
- `createStateStore(ctx, { log }): Promise<StateStore>` where `StateStore` has `backend`, `get(sessionID, baseDir)`, `isArmed(sessionID, baseDir)`, `set(sessionID, patch, baseDir)`.

- [ ] **Step 1: Write the failing test**

Add to `test/plugin.test.mjs` before the plugin drive section:

```js
import { createStateStore, sessionPaths } from "../lib/unattended-state.js"

const storeDir = path.join(PROJECT, "store-test")
const storage = new Map()
const store = await createStateStore({
  storage: {
    async get(k) { return storage.get(k) },
    async set(k, v) { storage.set(k, v) },
    async remove(k) { storage.delete(k) },
    async scan({ prefix }) {
      return { entries: [...storage].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  },
}, { log: () => {} })

await store.set("ses_a", { armed: true, armedAt: "2026-10-19T00:00:00.000Z" }, storeDir)
check("state store reports a session armed", await store.isArmed("ses_a", storeDir))
check("state store isolates another session", !(await store.isArmed("ses_b", storeDir)))
check("state store persists the record", storage.has("unattended/session/ses_a"))
check("session paths are per-session", sessionPaths(storeDir, "ses_a").dir !== sessionPaths(storeDir, "ses_b").dir)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/unattended-state.js'`.

- [ ] **Step 3: Implement `lib/unattended-state.js`**

Exact behaviour:

- `createStateStore` picks the backend once: `ctx.storage` if it exists and the hydrate
  `scan({ prefix, limit: 100, after? })` succeeds; otherwise `"files"`.
- Storage hydration loads every `unattended/session/<id>` value into a `Map`.
- `set` merges `{ sessionID, updatedAt }`, updates the map first, then persists.
- File backend writes `<sessionDir>/record.json` and mirrors `armed` to
  `<sessionDir>/ACTIVE`; a missing `record.json` plus an existing `ACTIVE`
  means armed (bootstrap for old per-session dirs).
- Storage write failures are passed to `log` and do not switch backends.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, including the four new checks.

- [ ] **Step 5: Commit**

```bash
git add lib/unattended-state.js test/plugin.test.mjs
git commit -m "feat(unattended): add per-session state store"
```

---

### Task 2: Rewire the plugin to the state store

**Files:**
- Modify: `lib/unattended.js`
- Test: `test/plugin.test.mjs`, `skills/unattended/scripts/unattended-selftest.mjs`

**Interfaces:**
- Consumes `createStateStore`, `sessionPaths`, `legacyPaths` from Task 1.
- `arm(sessionID, baseDir, source)` / `disarm(sessionID, baseDir, source, { notice })`.
- `contractFor(sessionID, paths)` / `offNoticeFor(sessionID, paths, armedAt)`.

- [ ] **Step 1: Add the failing per-session assertions**

In `test/plugin.test.mjs`, give the mock `ctx` a `storage` Map with
`get/set/remove/scan`, then after the existing prompt-hook test add:

```js
// Arm session A only.
await hooks.prompt({ sessionID: "ses_a", prompt: { text: "go [[opencode-unattended:on]]" } })
check("session A is armed", (await ctx.storage.get("unattended/session/ses_a"))?.armed === true)
check("session B is not armed", (await ctx.storage.get("unattended/session/ses_b")) === undefined)

// B's context request gets no contract.
const bSystem = []
await hooks.context({ sessionID: "ses_b", system: bSystem, messages: [] })
check("session B gets no contract", !bSystem.some((p) => String(p.text).includes("[[UNATTENDED-MODE-ACTIVE]]")))

// Off in A injects the off notice exactly once.
await hooks.prompt({ sessionID: "ses_a", prompt: { text: "stop [[opencode-unattended:off]]" } })
const aOff = []
await hooks.context({ sessionID: "ses_a", system: aOff, messages: [] })
check("off notice is injected", aOff.some((p) => String(p.text).includes("[[UNATTENDED-MODE-OFF]]")))
const aAgain = []
await hooks.context({ sessionID: "ses_a", system: aAgain, messages: [] })
check("off notice is not repeated", !aAgain.some((p) => String(p.text).includes("[[UNATTENDED-MODE-OFF]]")))
check("session B was untouched", (await ctx.storage.get("unattended/session/ses_b")) === undefined)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — state store still uses the project sentinel; B is armed.

- [ ] **Step 3: Replace the sentinel helpers in `lib/unattended.js`**

Implement:

- `setup()` creates `const state = await createStateStore(ctx, { log })` and tracks
  `const promptHookAvailable = typeof ctx?.session?.hook === "function"`.
- `baseDirFor(sessionID)` keeps its current behaviour.
- `arm` creates `{ armed: true, armedAt, disarmedAt: null, baseDir, reason, pendingNotice: false }`,
  appends the meta decision and human bullet to the **per-session** paths.
- `disarm` with `{ notice: true }` sets `pendingNotice: true`; a second off on an
  already-disarmed session is a no-op. The silent end-of-run disarm sets
  `pendingNotice: false` and clears nudge counters.
- `contractFor` lists the absolute `jsonl`, `decisions`, and `summary` paths.
- Every existing `isActive(baseDir)` call becomes `await state.isArmed(sessionID, baseDir)`.
- Remove `exists`, `isActive`, `activate`, `deactivate`, and `paths` helpers that
  are replaced; keep `appendDecision`/`appendHumanBullet` but point them at a
  `paths` argument.

- [ ] **Step 4: Update the context and prompt hooks**

- Prompt hook is `async`, returns early without a `sessionID`, and accepts the
  marker whose `lastIndexOf` is greater (OFF wins ties).
- Context hook:
  - no record → bootstrap-scan **user-role** messages, last marker wins;
  - armed → inject `contractFor` once (guard `[[UNATTENDED-MODE-ACTIVE]]`);
  - disarmed with `pendingNotice` → inject `offNoticeFor` once and clear the flag
    through `state.set`;
  - never inject when both are absent.
- `scanMessages` must filter to role `user` and skip parts containing the
  `GUARD` or `[[UNATTENDED-MODE-OFF]]` markers.
- When `promptHookAvailable` is false, also inspect the **newest** user message
  on every context request and act on an ON/OFF marker there.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS with the new isolation and off-notice checks.

- [ ] **Step 6: Commit**

```bash
git add lib/unattended.js test/plugin.test.mjs
git commit -m "feat(unattended): scope mode state to a session"
```

---

### Task 3: Natural end-of-run and idle nudges

**Files:**
- Modify: `lib/unattended.js`
- Test: `skills/unattended/scripts/unattended-selftest.mjs`

**Interfaces:**
- `lastAssistantText(messages): string`
- On `session.idle`, if armed, fetch `ctx.session.context({ sessionID })`; a
  trailing `[[opencode-unattended:off]]` in the last assistant message disarms
  silently and suppresses the nudge.

- [ ] **Step 1: Add the failing selftest case**

After the existing nudge test, add:

```js
// Assistant end marker disarms silently and suppresses the nudge.
await hooks.prompt({ sessionID: "ses_end", prompt: { text: "go [[opencode-unattended:on]]" } })
queue.push({ type: "session.idle", sessionID: "ses_end" })
// Mock ctx.session.context returns a completed run:
//   [{ role: "assistant", content: [{ type: "text", text: "done [[opencode-unattended:off]]" }] }]
await sleep(80)
check("end marker disarms", !(await ctx.storage.get("unattended/session/ses_end"))?.armed)
check("end marker suppresses the nudge", !prompts.some((p) => p.sessionID === "ses_end"))
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node skills/unattended/scripts/unattended-selftest.mjs`
Expected: FAIL — the session stays armed and receives a nudge.

- [ ] **Step 3: Implement the idle check**

In `onIdle(sessionID)`:

1. Resolve the record; return if not armed or if the session is a child.
2. If `ctx.session.context` exists, read the messages and find the last
   assistant-role message. If its text includes `OFF_MARKER`, call
   `disarm(sessionID, baseDir, "assistant-end", { notice: false })` and return.
3. Otherwise run the existing debounce/cap logic unchanged, but resolve `baseDir`
   through `baseDirFor` and write the per-session log.

- [ ] **Step 4: Run the selftest**

Run: `node skills/unattended/scripts/unattended-selftest.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/unattended.js skills/unattended/scripts/unattended-selftest.mjs
git commit -m "feat(unattended): disarm on the assistant end marker"
```

---

### Task 4: Commands, skill, and digest

**Files:**
- Modify: `commands/unattended-off.md`
- Modify: `commands/unattended.md`
- Modify: `skills/unattended/SKILL.md`
- Modify: `skills/unattended/scripts/unattended-digest.sh`
- Modify: `docs/unattended.md`, `README.md`

**Interfaces:**
- `/unattended-off` body uses the new handover wording and keeps the OFF marker.
- `unattended-digest.sh [--session <id>] [project-dir]`.

- [ ] **Step 1: Update the command bodies**

`commands/unattended-off.md` becomes exactly the block from the spec
("Leave unattended mode for this session …") including
`[[opencode-unattended:off]]` on its own line. `commands/unattended.md` gets one
clause: "for this session only".

- [ ] **Step 2: Update the skill**

Replace the Files table with the per-session layout; state that the plugin
injects absolute paths; document the immediate handover, the unattended-only
summary window (`ts >= armedAt`, exclude mode meta events), and the end-of-run
instruction to write the summary then end the final message with
`[[opencode-unattended:off]]`.

- [ ] **Step 3: Update the digest**

- Parse `--session <id>` and an optional project dir.
- Resolve `<project>/.opencode/unattended/sessions/<id>`.
- With no `--session`: use the only session dir; with several, list them and
  exit 2; with none, fall back to the legacy project-level files.
- Read `decisions.jsonl` and `SUMMARY.md` from the resolved directory.
- Keep `notify()` a no-op.

- [ ] **Step 4: Verify**

Run:

```bash
node test/plugin.test.mjs
node skills/unattended/scripts/unattended-selftest.mjs
bash -n skills/unattended/scripts/unattended-digest.sh
```

Expected: all pass; `bash -n` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add commands skills docs README.md
git commit -m "docs(unattended): document per-session mode and handover"
```

---

### Task 5: Full acceptance coverage

**Files:**
- Modify: `test/plugin.test.mjs`
- Modify: `skills/unattended/scripts/unattended-selftest.mjs`

- [ ] **Step 1: Add the remaining spec cases**

Cover, at minimum:

1. Two sessions, one project: A armed, B not; B gets no contract.
2. Off in A: A disarmed, B untouched; notice once.
3. History replay: no record + ON then OFF ⇒ disarmed; later ON ⇒ armed.
4. Stored off + stale ON history ⇒ still off.
5. No `ctx.storage`: per-session file backend isolates A and B.
6. Nudges: armed A nudged, disarmed A not, B never.
7. Child sessions: no state, contract, or nudge.
8. Assistant end marker: silent disarm, no nudge.
9. Legacy project `ACTIVE`: arms nobody.
10. Contract contains the session's absolute paths.

- [ ] **Step 2: Run everything**

Run:

```bash
npm test
node skills/unattended/scripts/unattended-selftest.mjs
```

Expected: PASS, zero failures.

- [ ] **Step 3: Commit**

```bash
git add test/plugin.test.mjs skills/unattended/scripts/unattended-selftest.mjs
git commit -m "test(unattended): cover per-session isolation and handover"
```
