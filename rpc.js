// The unattended RPC contract.
//
// Two halves of this package talk through it:
//
//   * the server plugin (index.js -> lib/unattended.js) registers it with
//     `ctx.rpc.register(...)` and answers `status` from the per-session
//     record it already owns;
//   * the TUI plugin (tui.jsx) calls it with `context.client.rpc(...)` and
//     listens to the `changed` event.
//
// Why an RPC at all? The TUI half runs in the terminal, the state lives in the
// server plugin's `ctx.storage`. There is no endpoint that exposes plugin
// storage to clients, and the TUI's own `context.storage` is a different
// store. The RPC is the only read path that also works against a remote
// server, because it travels over the same HTTP API the TUI already uses.
//
// It is a plain object on purpose: the TUI host exposes "@opencode/plugin/tui"
// but not "@opencode/plugin/rpc", so this file must stay importable from both
// halves without any host module. The server side tries `Rpc.define` on it
// first and falls back to the plain definition.

export const UNATTENDED_RPC_ID = "unattended"

export const Unattended = {
  id: UNATTENDED_RPC_ID,
  methods: {
    // Is unattended mode on for this session?
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          armed: { type: "boolean" },
          since: { type: "string" },
        },
        required: ["armed"],
        additionalProperties: false,
      },
    },
  },
  events: {
    // The session was armed or disarmed.
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          armed: { type: "boolean" },
          since: { type: "string" },
        },
        required: ["sessionID", "armed"],
        additionalProperties: false,
      },
    },
  },
}
