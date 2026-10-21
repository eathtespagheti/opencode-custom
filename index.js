// opencode-custom — an OpenCode V2 plugin package that ships Fabio's own
// customizations so they can be installed and updated on any machine:
//
//   opencode plugin add git+https://gitlab.com/eathtespagheti/opencode-custom.git
//
// The V2 supervisor reads `{ id, setup }` from the default export and calls
// setup(ctx) once per project location it serves. setup registers:
//   * skills/   -> native skills        (ctx.skill.transform)
//   * agents/   -> subagents            (ctx.agent.transform)
//   * commands/ -> slash commands       (ctx.command.transform)
//   * the unattended glue/hooks         (lib/unattended.js)
//
// No dependencies: plain ESM, matching the shape the superpowers plugin uses.
import path from "path"
import { fileURLToPath } from "url"
import fs from "fs"
import { registerSkills } from "./lib/register-skills.js"
import { registerCommands } from "./lib/register-commands.js"
import { registerAgents } from "./lib/register-agents.js"
import { readProjectConfig, buildPermissions } from "./lib/docs-config.js"
import unattended from "./lib/unattended.js"

const root = path.dirname(fileURLToPath(import.meta.url))

export default {
  id: "opencode-custom",

  async setup(ctx) {
    // The unattended skill's digest script lives beside it in the package, so a
    // hard-coded ~/.config path is wrong on every other machine. Resolve the
    // real path here and substitute it into the skill body at registration.
    const digestScript = path.join(
      root, "skills", "unattended", "scripts", "unattended-digest.sh",
    )
    const docsCheckScript = path.join(
      root, "skills", "docs-sync", "scripts", "docs-check.sh",
    )

    // Everything repo-specific about docs-keeper lives in the project's
    // `.opencode/docs-sync.json`. The plugin derives the agent's permission
    // fence and the prompt substitutions from it, so the shipped files stay
    // generic and work in any repository.
    const projectDir =
      ctx?.location?.directory || ctx?.location?.project?.directory || process.cwd()
    const { config } = readProjectConfig(projectDir)

    // A project that defines docs-keeper or docs-sync itself keeps its own
    // version; the generic one is skipped for that project.
    const skills = path.join(projectDir, ".opencode", "skills", "docs-sync")
    const agents = path.join(projectDir, ".opencode", "agents", "docs-keeper.md")
    const hasLocalSkill = fs.existsSync(skills)
    const hasLocalAgent = fs.existsSync(agents)

    const excludeAgents = hasLocalAgent ? ["docs-keeper"] : []
    const skillVars = { DIGEST_SCRIPT: digestScript, DOCS_CHECK_SCRIPT: docsCheckScript }
    if (hasLocalSkill) skillVars.exclude = ["docs-sync"]

    await registerSkills(ctx, path.join(root, "skills"), skillVars)
    await registerCommands(ctx, path.join(root, "commands"))
    await registerAgents(ctx, {
      dir: path.join(root, "agents"),
      exclude: excludeAgents,
      vars: {
        SOURCE_OF_TRUTH: config.sourceOfTruth ||
          "the repository's actual implementation (code, manifests, configuration).",
        ALLOWED_DOCS: config.docs.length > 0
          ? config.docs.join(", ")
          : "no doc paths are configured for this repository, so edits are denied; " +
            "see `.opencode/docs-sync.json`.",
        PROTECTED_DOCS: config.readOnlyDocs.length > 0
          ? config.readOnlyDocs.join(", ")
          : "`docs/superpowers/**` (historical, read-only)",
        DOC_MAP: config.docMap ||
          "not configured for this repository — derive the change→doc mapping " +
          "yourself by reading each doc surface.",
        STYLE: config.style ||
          "not configured — match the surrounding prose and each surface's own " +
          "conventions.",
      },
      permissions: buildPermissions(config, { scriptPath: docsCheckScript }),
    })

    // Returns a cleanup function (or undefined when disabled), which we pass on
    // so OpenCode can dispose the hooks/subscription on unload.
    return await unattended.setup(ctx)
  },
}
