// opencode-custom — an OpenCode V2 plugin package that ships Fabio's own
// customizations so they can be installed and updated on any machine:
//
//   opencode plugin add git+https://gitlab.com/eathtespagheti/opencode-custom.git
//
// The V2 supervisor reads `{ id, setup }` from the default export and calls
// setup(ctx) once at load. setup registers:
//   * skills/   -> native skills        (ctx.skill.transform)
//   * commands/ -> slash commands       (ctx.command.transform)
//   * the unattended glue/hooks         (lib/unattended.js)
//
// No dependencies: plain ESM, matching the shape the superpowers plugin uses.
import path from "path"
import { fileURLToPath } from "url"
import { registerSkills } from "./lib/register-skills.js"
import { registerCommands } from "./lib/register-commands.js"
import unattended from "./lib/unattended.js"

const root = path.dirname(fileURLToPath(import.meta.url))

export default {
  id: "opencode-custom",

  async setup(ctx) {
    // The unattended skill's digest script lives beside it in the package, so a
    // hard-coded ~/.config path is wrong on every other machine. Resolve the
    // real path here and substitute it into the skill body at registration.
    const digestScript = path.join(
      root,
      "skills",
      "unattended",
      "scripts",
      "unattended-digest.sh",
    )

    await registerSkills(ctx, path.join(root, "skills"), { DIGEST_SCRIPT: digestScript })
    await registerCommands(ctx, path.join(root, "commands"))

    // Returns a cleanup function (or undefined when disabled), which we pass on
    // so OpenCode can dispose the hooks/subscription on unload.
    return await unattended.setup(ctx)
  },
}
