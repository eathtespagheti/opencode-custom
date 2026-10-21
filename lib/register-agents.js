// Registers the package's subagents with OpenCode V2.
//
// agents/<name>.md carries everything that is repository-agnostic: frontmatter
// `description`, `mode` and `temperature`, and the system-prompt body. What is
// specific to a given repository — the doc map, the style notes, the allowed
// edit paths and the checker script's absolute path — is substituted into that
// body from per-project configuration, mirroring how skill bodies get their
// {{VAR}} placeholders resolved.
//
// Fallback rules ({{VAR}} with no value) collapse to empty strings, so a
// project without configuration yields a conservative body.
import fs from "fs"
import path from "path"
import { parseFrontmatter } from "./frontmatter.js"

export function substitute(body, vars) {
  let out = body
  for (const [key, value] of Object.entries(vars ?? {})) {
    out = out.replaceAll(`{{${key}}}`, String(value ?? ""))
  }
  return out
}

/** @returns {Array<{name, data: Record<string,string>, content:string}>} */
export function collectAgents(agentsDir) {
  const out = []
  if (!fs.existsSync(agentsDir)) return out

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const { data, content } = parseFrontmatter(
      fs.readFileSync(path.join(agentsDir, entry.name), "utf8"),
    )
    const name = data.name || entry.name.replace(/\.md$/, "")
    out.push({ name, data, content })
  }

  return out
}

/**
 * Register agents. `skip` lists agent names for which the project already
 * provides its own definition — those must win, so we do not register ours.
 *
 * @param {{agent?: {transform?: Function}}} ctx
 * @param {{dir: string, vars?: Record<string,string>, skip?: string[]}} opts
 */
export async function registerAgents(ctx, opts) {
  const { dir, vars = {}, skip = [] } = opts
  if (!ctx?.agent || typeof ctx.agent.transform !== "function") return

  const defs = collectAgents(dir).filter((d) => !skip.includes(d.name))
  if (defs.length === 0) return

  await ctx.agent.transform((editor) => {
    for (const def of defs) {
      editor.update(def.name, (agent) => {
        agent.name = def.name
        if (def.data.description) agent.description = def.data.description
        if (def.data.mode) agent.mode = def.data.mode
        if (def.data.temperature) {
          const t = Number(def.data.temperature)
          if (Number.isFinite(t)) agent.request = { ...agent.request, body: { ...agent.request?.body, temperature: t } }
        }
        agent.system = substitute(def.content, vars)
        if (opts.permissions) agent.permissions = opts.permissions
      })
    }
  })
}
