// Registers the package's slash commands with OpenCode V2.
//
// Each commands/<name>.md becomes a command: frontmatter `description` plus the
// trimmed body as the prompt template. Commands registered through
// ctx.command.transform take an `execute` (not a `template` field), so execute
// submits the body to the session — the same effect as the old
// ~/.config/opencode/commands/*.md files, now shipped with the plugin.
import fs from "fs"
import path from "path"
import { parseFrontmatter } from "./frontmatter.js"

/** @returns {Array<{name,description?,template}>} */
export function collectCommands(commandsDir) {
  const out = []
  if (!fs.existsSync(commandsDir)) return out

  for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const { data, content } = parseFrontmatter(
      fs.readFileSync(path.join(commandsDir, entry.name), "utf8"),
    )

    out.push({
      name: entry.name.replace(/\.md$/, ""),
      ...(data.description ? { description: data.description } : {}),
      template: content.trim(),
    })
  }

  return out
}

export async function registerCommands(ctx, commandsDir) {
  if (!ctx?.command || typeof ctx.command.transform !== "function") return

  const defs = collectCommands(commandsDir)
  if (defs.length === 0) return

  await ctx.command.transform((editor) => {
    for (const def of defs) {
      editor.add({
        name: def.name,
        ...(def.description ? { description: def.description } : {}),
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({ ...prompt, sessionID, text: def.template, delivery })
        },
      })
    }
  })
}
