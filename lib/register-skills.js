// Registers the package's skills with OpenCode V2.
//
// Mirrors the superpowers plugin: read each skills/<id>/SKILL.md, split off the
// frontmatter, and add a Skill.Info to the skill draft. `content` is the body
// (what the agent loads); `{{NAME}}` placeholders in the body are substituted
// from `vars` so a skill can point at a path that only exists in the install
// directory (see index.js).
import fs from "fs"
import path from "path"
import { parseFrontmatter } from "./frontmatter.js"

/** @returns {Array<{id,name,description?,path,content}>} */
export function collectSkills(skillsDir, vars = {}) {
  const out = []
  if (!fs.existsSync(skillsDir)) return out

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue

    const skillPath = path.join(skillsDir, entry.name, "SKILL.md")
    if (!fs.existsSync(skillPath)) continue

    const { data, content } = parseFrontmatter(fs.readFileSync(skillPath, "utf8"))

    let body = content
    for (const [key, value] of Object.entries(vars)) {
      body = body.split(`{{${key}}}`).join(value)
    }

    out.push({
      id: entry.name,
      name: data.name || entry.name,
      ...(data.description ? { description: data.description } : {}),
      path: skillPath,
      content: body,
    })
  }

  return out
}

export async function registerSkills(ctx, skillsDir, vars) {
  if (!ctx?.skill || typeof ctx.skill.transform !== "function") return

  const skills = collectSkills(skillsDir, vars)
  if (skills.length === 0) return

  await ctx.skill.transform((draft) => {
    for (const skill of skills) draft.add(skill)
  })
}
