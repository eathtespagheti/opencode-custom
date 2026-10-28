// GENERATED FILE — do not edit.
// Source: tui.jsx. Regenerate with `npm run build`.
//
// OpenCode does not apply its Solid JSX transform to files inside
// node_modules, so the installed package must ship compiled JS. The imports
// below (@opentui/solid, solid-js, @opencode/plugin/tui) are provided by the
// OpenCode host as virtual modules.
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
// The TUI half of the opencode-custom plugin.
//
// It shows a small badge in the sidebar that says whether the *active session*
// is in unattended mode:
//
//     ● unattended   (amber)  the session is running unattended
//     ○ unattended   (dim)    the session is known to be in normal mode
//     (nothing)               the state is unknown — see below
//
// The state lives in the server plugin (lib/unattended.js), which owns the
// per-session record. The terminal cannot read that record directly, so the
// state is read through the "unattended" RPC (see rpc.js).
//
// The rule that matters most here: **unknown is not off**. When the RPC cannot
// be reached (the server half is missing, the server is unreachable, the RPC
// was not registered yet) the badge renders nothing at all. A badge that says
// "off" while the truth is "I do not know" is worse than no badge, because it
// invites the user to leave a session unattended while it is armed.
//
// The server plugin stays the single source of truth: this half only reads.

import fs from "fs";
import { createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { Unattended } from "./rpc.js";
import { createIndicator } from "./lib/indicator.js";

// How often to re-check, in case an event was missed (they are live-only) or
// the server was not ready yet when the first attempt failed.
const SAFETY_REFRESH_MS = 60_000;

/** Debug log, next to the other unattended artifacts of the project. */
function makeLogger(context) {
  if (process.env.UNATTENDED_DEBUG !== "1") return () => {};
  const dir = context?.location?.directory;
  if (!dir) return () => {};
  const file = `${dir}/.opencode/unattended/tui.log`;
  return msg => {
    try {
      fs.mkdirSync(`${dir}/.opencode/unattended`, {
        recursive: true
      });
      fs.appendFileSync(file, `${new Date().toISOString()} [unattended-tui] ${msg}\n`);
    } catch {/* never fail the UI because of logging */}
  };
}
export default Plugin.define({
  id: "opencode-custom.tui",
  setup(context) {
    const log = makeLogger(context);

    // The RPC subclient. When the server half is not there, every call fails
    // and the badge stays hidden — which is the intended behaviour.
    const api = typeof context?.client?.rpc === "function" ? context.client.rpc(Unattended) : undefined;
    log(`setup (rpc available: ${!!api}, location: ${context?.location?.directory ?? "?"})`);
    const indicator = createIndicator({
      api,
      log
    });
    const stopEvents = indicator.start();

    // The signal only says "something changed"; the state itself lives in the
    // indicator. A change that does not change anything does not bump the
    // signal, so the sidebar does not redraw for nothing.
    const [version, setVersion] = createSignal(0);
    const unsubscribe = indicator.subscribe(() => setVersion(n => n + 1));

    // The session the sidebar is showing last.
    let currentSessionID;
    const theme = context?.theme;
    const armedColor = theme?.text?.feedback?.warning?.base ?? "yellow";
    const offColor = theme?.text?.muted ?? "gray";
    const unregister = context.ui.slot({
      append: "sidebar.footer",
      render: props => {
        const sessionID = () => props?.sessionID;

        // Fetch the state when the sidebar starts showing another session.
        // (A plain check, not an effect: the render function may run again on
        // every state change, and a new effect each time would loop.)
        const id = sessionID();
        if (id && id !== currentSessionID) {
          currentSessionID = id;
          void indicator.refreshWithRetry(id);
        }

        // Read through the accessors so the badge follows the signal.
        const label = () => {
          version();
          const state = indicator.get(sessionID());
          if (!state) return "";
          return state.armed ? "● unattended" : "○ unattended";
        };
        const color = () => {
          version();
          const state = indicator.get(sessionID());
          if (!state) return offColor;
          return state.armed ? armedColor : offColor;
        };
        return (() => {
          var _el$ = _$createElement("text");
          _$insert(_el$, label);
          _$effect(_$p => _$setProp(_el$, "fg", color(), _$p));
          return _el$;
        })();
      }
    });

    // Safety net: events are live-only, so re-check now and then. This also
    // repairs a badge that never got a state because the server was not ready.
    const timer = setInterval(() => {
      if (currentSessionID) void indicator.refresh(currentSessionID);
    }, SAFETY_REFRESH_MS);
    if (typeof timer?.unref === "function") timer.unref();
    return () => {
      try {
        stopEvents?.();
      } catch {/* ignore */}
      try {
        unsubscribe?.();
      } catch {/* ignore */}
      try {
        clearInterval(timer);
      } catch {/* ignore */}
      try {
        unregister?.();
      } catch {/* ignore */}
    };
  }
});