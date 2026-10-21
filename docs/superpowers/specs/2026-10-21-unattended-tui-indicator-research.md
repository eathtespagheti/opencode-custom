# Unattended indicator in the OpenCode TUI — research and recommendation

**Date:** 2026-10-21
**Status:** research complete — implemented (see §9)
**Ticket:** [#2 — Research: unattended-mode indicator in the OpenCode sidebar](https://gitlab.com/eathtespagheti/opencode-custom/-/issues/2)
**Target:** OpenCode **v2.1.1** (`/usr/bin/opencode`), V2 plugin + CLI (TUI) plugin APIs

## TL;DR

Yes, the V2 CLI plugin API can put a persistent per-session indicator in the
sidebar: `context.ui.slot({ append: "sidebar.footer", render: ({ sessionID }) => … })`
— **verified end to end** against a real TUI on this machine.

The blocker is not the UI, it is the *state*: the unattended state lives in the
**server** plugin (`ctx.storage`), and the TUI half is a **different process**
with its own, non-shared storage. The state has to travel over the wire.

**Recommendation:** expose the state through a **plugin RPC**
(`Rpc.define` → `ctx.rpc.register` → `context.client.rpc(...)`) and let a new
`./tui` entrypoint of this package render it into `sidebar.footer`, updating
live from the RPC's `changed` event.

## 1. What the TUI plugin API offers

From the official CLI plugin guide
(<https://opencode.ai/v2/docs/build/plugins/cli>) and the `opencode` binary
itself:

| Surface | API | Use for this ticket |
| --- | --- | --- |
| **Slots** | `context.ui.slot({ append \| prepend \| before \| after \| replace, render })` | **the indicator** |
| Slot targets | `app`, `home.footer`, `home.footer.status`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`, `session.composer.top`, **`sidebar.content`**, **`sidebar.footer`** | `sidebar.footer` = persistent, bottom of the right sidebar |
| Toasts | `context.ui.toast.show({ title, message, variant, duration })` | one-off "unattended on/off" notices (complement, not a replacement) |
| Panels | `context.ui.panel.open(id, { presentation })` | a full toggleable panel (heavier than needed) |
| Routes / tabs | `context.ui.router.register({ name, render })` | a dedicated page (overkill) |
| Local state | `context.storage.store(name, { initial })` / `.memory(name, …)` | **not** usable for the server's state (see §2) |
| Server access | `context.client` (OpenCode client) | RPC calls, session data, event stream |

Slot contract: `render` receives reactive props including **`sessionID`** (plus
`name`, `width`, `presentation`, `focused` for panels). It returns JSX
(Solid). The host owns mount/unmount; the plugin returns an unregister function
from `setup`.

The slot contract is not theoretical — OpenCode's own built-in sidebar plugins
use it, e.g. `opencode.sidebar.mcp`:

```js
Plugin.define({
  id: "opencode.sidebar.footer",
  setup(t) {
    t.ui.slot({ append: "sidebar.footer", render: (n) => /* … */ })
  },
})
```

## 2. Where the state lives today, and why the TUI cannot just read it

`lib/unattended-state.js` keeps one record per session:

* **primary:** `ctx.storage` (server plugin) — keys `unattended/session/<id>`;
* **fallback:** files under `<project>/.opencode/unattended/sessions/<id>/`.

Measured facts (probe plugin, opencode v2.1.1):

| Store | Where it lands | Visible to the TUI? |
| --- | --- | --- |
| server plugin `ctx.storage` | SQLite `kv` table, key `plugin:<utf16le-hex(pluginId)>:<key>` (e.g. `plugin:00700072006f0062…:probe/key`) | **no** — no HTTP endpoint exposes plugin storage (`/api/plugin` only offers `list`, `check`, `update`) |
| TUI plugin `context.storage.store()` | local JSON file `<state>/<channel>/tui/<name>.json` (store name is prefixed `plugin.<pluginId>.`) | local to the TUI process/machine |

So the two storages are **different stores with different key formats**. A TUI
plugin cannot read the server plugin's `ctx.storage` directly, and the
server's fallback file only helps when TUI and server share a filesystem
(local server only — it breaks for a remote server).

## 3. The transport that works: plugin RPC

V2 plugins can publish an RPC contract that runs **on the server** and is
callable by other plugins and by clients over HTTP
(<https://opencode.ai/v2/docs/build/plugins/rpc>).

Server side (`ctx.rpc.register`):

```js
const { Rpc } = await import("@opencode/plugin/rpc") // resolved by the host at runtime

const Unattended = Rpc.define({
  id: "unattended",
  methods: {
    status: {
      input:  { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { armed: { type: "boolean" } }, required: ["armed"], additionalProperties: false },
    },
  },
  events: {
    changed: {
      schema: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
    },
  },
})

const registration = await ctx.rpc.register(Unattended, {
  status: async (input) => ({ armed: isArmed(input.sessionID) }),
})

await registration.events.emit("changed", { sessionID: "ses_…" })
```

Client side (TUI plugin, or any client):

```js
const api = context.client.rpc(Unattended)
const { armed } = await api.status({ sessionID })
const stop = api.events.on("changed", (event) => { /* … */ })
```

Verified behaviour on this machine:

* `ctx.rpc.register(...)` works from a server plugin; `ctx.rpc(Def).status(...)`
  calls it in-process.
* Over HTTP: `POST /api/rpc/<rpcId>/<method>?location=<dir>` with body
  `{"input": {…}}` → `{"result": …}`. The rpc id is the `Rpc.define({ id })`
  value (`unattended`), **not** the plugin id.
* RPC events are broadcast on the server event stream as
  `type: "rpc.<rpcId>.<event>"` with `{ location, data }` — e.g.
  `rpc.probe.changed` — so the TUI's `context.data.listen`/`data.on` sees them
  too (the CLI guide documents the same `rpc.acme.updated` shape).
* Events are **live-only**: a TUI that starts after a session was armed must
  fetch the current state with the `status` method. Hence: method *and* event.

This is the only mechanism that also works against a **remote** server: the RPC
travels over the same HTTP API the TUI already uses.

## 4. Options considered

| # | Option | How | Verdict |
| --- | --- | --- | --- |
| **A** | **Plugin RPC + a `./tui` entrypoint** (server registers `unattended.status` + `changed` event; TUI renders a sidebar slot) | `ctx.rpc.register` → `context.client.rpc` → `context.ui.slot` | **Recommended.** Only option that is correct for local *and* remote servers, reacts live, and keeps the per-session semantics. |
| B | TUI plugin reads the server's fallback file from disk | `<project>/.opencode/unattended/sessions/<id>/record.json` | Rejected: needs a shared filesystem (breaks for remote servers), races with the server's own writes, and duplicates the state. |
| C | TUI plugin reads the server's `ctx.storage` | — | Impossible: no HTTP endpoint for plugin storage; the TUI store is a different store with a different key format. |
| D | TUI plugin infers the state from the transcript (look for the injected contract) | read session messages | Rejected: heuristic, lags behind, breaks on compaction, can mislead. |
| E | Toast on arm/disarm only | `context.ui.toast.show` | Not a persistent indicator (toasts expire), but a cheap **complement** to A. |
| F | Encode the state in session metadata/title | `session.update` | Rejected: pollutes user-visible session data for a UI concern. |
| G | Own panel | `context.ui.panel.open` | Rejected: heavyweight for an on/off badge; panels need keybindings and full-screen handling. |

## 5. Recommended design

```
opencode-custom/
├── index.js          # server plugin (unchanged) + ctx.rpc.register(Unattended, …)
├── rpc.js            # NEW: Rpc.define({ id: "unattended", … }) — shared contract
├── tui.jsx           # NEW: CLI (TUI) plugin — renders the sidebar indicator
└── lib/unattended.js # arms/disarms; now also emits the "changed" RPC event
```

**Server plugin (`index.js` / `lib/unattended.js`)**

1. Register the RPC in `setup`: `status` returns `{ armed }` for a session id
   (read from the existing per-session store — same source of truth as today,
   no new state).
2. Emit `changed` (payload `{ sessionID, armed }`) whenever a session is armed,
   disarmed, or re-armed — i.e. from the same places that write the record.
   The RPC registration must exist before the first arming, so register it at
   the top of `setup`.

**TUI plugin (`tui.jsx`)**

```jsx
import { Plugin } from "@opencode/plugin/tui"
import { Unattended } from "./rpc.js"

export default Plugin.define({
  id: "opencode-custom.tui",
  setup(context) {
    const api = context.client.rpc(Unattended)
    // per-session state; "unknown" until the first successful status() call
    // …
    const stop = api.events.on("changed", (event) => update(event.data.sessionID, event.data.armed))

    return context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => {
        const state = readState(sessionID)      // undefined = unknown
        if (!state) return null                  // unknown ⇒ render nothing
        return <text fg={state.armed ? "yellow" : "muted"}>
          {state.armed ? "● unattended" : "○ unattended"}
        </text>
      },
    })
  },
})
```

### Rules the implementation must follow

1. **Unknown ≠ off.** If the RPC call fails (server plugin missing, server
   unreachable, RPC not registered), the indicator renders **nothing**. An
   "off" badge that is really "unknown" is worse than no badge.
2. **Per session.** The badge is bound to the `sessionID` the slot hands us, so
   two open sessions never show the same state. Switching sessions must
   re-read the state (the slot's `render` is re-invoked with the new id — needs
   verification in the implementation ticket).
3. **Off is quiet.** "Unattended on" is the loud state (yellow/amber badge);
   "off" can be a dim line, or omitted entirely. The badge's job is to be
   noticeable when the user is *not* watching.
4. **The server plugin stays the source of truth.** The TUI never writes state.
   The RPC is a read-only projection of the record that already exists.
5. **Degrade, don't fail.** A missing TUI half (older package, remote server
   without the plugin) must not affect unattended mode at all.

### Packaging notes (verified)

* Plugin entrypoints are resolved **by file name inside the plugin directory**:
  `server` → `index` for the server half, `tui` for the TUI half, `rpc` for the
  contract. `tui.jsx` next to `index.js` is picked up (verified with a probe
  package).
* JSX must live in `.jsx`/`.tsx` (that is what the host's Solid transform
  matches); `@opencode/plugin/tui`, `@opentui/solid` and `solid-js` are
  provided as virtual modules by the host — no local dependency needed.
* The TUI half must be *enabled*: either the package is listed in
  `opencode.json` (server list, `./tui` auto-loads) or in `cli.json`
  (`plugins: [...]`, the CLI-only list). Which of the two is sufficient for a
  package that has **both** halves is an open question — the implementation
  ticket should test it (probe: `opencode plugin list` shows CLI plugins, and
  the TUI logs its plugin setup).

## 6. Verification performed

Everything below was executed on this machine (opencode v2.1.1):

| Check | Result |
| --- | --- |
| `context.ui.slot` exists in the TUI plugin API | ✅ found in the CLI plugin context builder and in OpenCode's own built-in sidebar plugins |
| TUI plugin renders into `sidebar.content` | ✅ probe plugin registered the slot; running the TUI in a pty (`opencode --continue`) showed the text in the session view's sidebar (home screen has no sidebar) |
| Server plugin `ctx.storage` persistence | ✅ row written to the `kv` table, key `plugin:<hex(pluginId)>:<key>` |
| TUI plugin storage is a separate local store | ✅ `<state>/<channel>/tui/<name>.json` in the TUI code path; different key format, no sharing with the server |
| `ctx.rpc.register` + in-process call | ✅ `REGISTER_OK` / `CALL_OK {"armed":true}` |
| RPC over HTTP | ✅ `POST /api/rpc/probe/status` with `{"input":{"sessionID":"ses_test"}}` → `{"result":{"armed":true}}` |
| RPC event on the server stream | ✅ `data: {"type":"rpc.probe.changed","location":{…},"data":{"sessionID":"ses_probe"}}` |
| `import("@opencode/plugin/rpc")` resolves at runtime | ✅ resolved by the host without a local install |

Reproduce with the probe package in `~/.cache/opencode-tui-probe`
(`tui.jsx`, `package.json` with `"./tui"` export) and a scratch server plugin.

## 7. Risks / open questions

1. **Slot collisions.** `sidebar.content`/`sidebar.footer` are shared with the
   built-in MCP/todo/footer plugins. Appending (not replacing) avoids damage,
   but the exact placement should be eyeballed in a real session.
2. **Re-render on session switch.** Unverified whether the slot's `render` is
   re-invoked (with the new `sessionID`) when the user switches sessions; if
   not, the implementation must subscribe to route/session changes.
3. **Home screen has no sidebar.** The badge is only visible in a session view
   — acceptable (unattended mode is a session concept), but worth stating.
4. **Remote server.** The TUI half runs locally, the server half remotely; the
   RPC covers that, but the *package* must be installed in both places.
5. **Event loss.** RPC events are live-only; the `status` method is the
   authority at startup. A TUI that misses an event must still converge
   (re-fetch on session change, or on any error).
6. **Packaging.** Adding a `./tui` export means the package now has a UI
   half; `opencode plugin list` and the CLI plugin loader must keep working
   for server-only installs.

## 8. Suggested follow-up

A separate implementation ticket:

1. `rpc.js` — the `unattended` RPC contract (`status` method + `changed` event).
2. Register it in the server plugin; emit `changed` on arm/disarm.
3. `tui.jsx` — sidebar badge (`sidebar.footer`) with the unknown-state rule.
4. Toast on arm/disarm as a complement.
5. Acceptance: TUI shows the badge for an armed session, hides it when off or
   unknown, and updates live on `/unattended` and `/unattended-off`.

## 9. What was built (issue #3)

Implemented as recommended:

| File | Role |
| --- | --- |
| `rpc.js` | The `unattended` contract: `status` method, `changed` event. A plain object, because the TUI host does not expose `@opencode/plugin/rpc`; the server prefers the host's `Rpc.define` and falls back to the plain definition. |
| `lib/unattended.js` | Registers the RPC (`ctx.rpc.register`) and emits `changed` from `arm()` / `disarm()`. The record stays the single source of truth. |
| `lib/indicator.js` | The badge state machine: known/unknown per session, retries, stale-answer guard, strict parsing. Plain JS, unit tested. |
| `tui.jsx` | The TUI half: `context.client.rpc(...)` + `context.ui.slot({ append: "sidebar.footer" })`, wired to a Solid signal. |

### What the research did not know

1. **The TUI half is loaded from the server plugin list.** A package listed in
   `opencode.json` is enough — the host resolves the `tui` entrypoint of the
   package. No `cli.json` entry is needed. But the host only *activates* the TUI
   half of a plugin the server reports, so a server without the plugin shows no
   badge at all (which is the wanted outcome anyway).
2. **The slot's `render` runs again on every state change.** Creating a
   `createEffect` inside it therefore creates a new effect per repaint, and a
   fetch inside that effect writes state, which repaints, which creates another
   effect — a render storm (observed as OpenTUI `OutputBackpressure` errors).
   The implementation keeps the state in a plain map, bumps a signal only when
   something really changed, and fetches on a session change instead of in an
   effect.
3. **The first status call can fail or hang** while the server plugin is still
   loading. The indicator retries (0.5 s, 2 s, 5 s), times a single call out
   after 10 s, and falls back to a 60 s safety-net refresh.

### Verified against a live opencode v2.1.1

- the badge shows `○ unattended` for a session that is known to be off, and
  `● unattended` while it is armed;
- it flips live in both directions when the session is armed or disarmed
  (driven by the `changed` event);
- with the RPC unavailable nothing is rendered at all — unknown is never shown
  as "off";
- two sessions show independent badges.

### Not done

- The toast on arm/disarm (a nice complement) is not implemented.
- The home screen has no sidebar, so the badge only exists in a session view.
