// Tiny frontmatter reader for SKILL.md / command markdown.
//
// Handles the subset these files use: a leading `---` block of `key: value`
// lines (optionally quoted) with indented continuation lines, then the body.
// It is not a full YAML parser — nested maps flatten into their parent key.

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, content: raw }

  const data = {}
  let lastKey = null

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    const colon = line.indexOf(":")

    if (colon > 0 && !/^\s/.test(line)) {
      const key = line.slice(0, colon).trim()
      let value = line.slice(colon + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      data[key] = value
      lastKey = key
    } else if (lastKey && /^\s+\S/.test(line)) {
      // Continuation of the previous value (wrapped line).
      data[lastKey] = `${data[lastKey]} ${line.trim()}`
    }
  }

  return { data, content: match[2] }
}
