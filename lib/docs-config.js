// Per-project configuration for the docs-keeper agent and the docs-sync skill.
//
// The plugin ships one generic implementation of both. Everything that is
// specific to a repository — which files are documentation, which paths may be
// edited, which paths are the source of truth, what the doc map looks like —
// lives in a per-project config file so the plugin itself stays repo-agnostic.
//
// Config file: <project>/.opencode/docs-sync.json
//
//   {
//     "sourceOfTruth": "flux/",            // one-line description of the truth
//     "docs": ["OVERVIEW.md", "README.md"],// doc files the agent may edit
//     "docDirs": ["docs/"],                // doc directories the agent may edit
//     "readOnlyDocs": ["docs/superpowers/"], // doc paths the agent must not edit
//     "check": { "docs": ["README.md"], "skipDirs": ["docs/superpowers/"] },
//     "docMap": "| Change | Docs |\n|---|---|\n| ... | ... |",
//     "style": "conventions prose"
//   }
//
// Every field is optional. A project with no config file gets conservative
// defaults (read-only agent, no doc surfaces), so an unconfigured project never
// gains write access it did not ask for.

import fs from "fs"
import path from "path"

const CONFIG_NAME = "docs-sync.json"

/** Default config: a read-only agent with no doc surfaces. */
export function defaultConfig() {
  return {
    sourceOfTruth: "",
    docs: [],
    docDirs: [],
    readOnlyDocs: [],
    check: { docs: [], skipDirs: [] },
    docMap: "",
    style: "",
  }
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((v) => typeof v === "string" && v.length > 0)
}

function asString(value) {
  return typeof value === "string" ? value : ""
}

/**
 * Merge a raw parsed object over the defaults. Unknown keys are ignored, so a
 * typo in the config never crashes the plugin.
 */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  if (!raw || typeof raw !== "object") return base

  const check = raw.check && typeof raw.check === "object" ? raw.check : {}

  return {
    sourceOfTruth: asString(raw.sourceOfTruth) || base.sourceOfTruth,
    docs: asStringArray(raw.docs),
    docDirs: asStringArray(raw.docDirs),
    readOnlyDocs: asStringArray(raw.readOnlyDocs),
    check: {
      docs: asStringArray(check.docs),
      skipDirs: asStringArray(check.skipDirs),
    },
    docMap: asString(raw.docMap),
    style: asString(raw.style),
  }
}

/**
 * Read the config for a project directory.
 * @returns {{config: ReturnType<typeof normalizeConfig>, path: string|null}}
 */
export function readProjectConfig(projectDir) {
  const file = path.join(projectDir, ".opencode", CONFIG_NAME)
  try {
    if (!fs.existsSync(file)) return { config: defaultConfig(), path: null }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    return { config: normalizeConfig(raw), path: file }
  } catch {
    // A malformed config must not break the plugin; fall back to defaults.
    return { config: defaultConfig(), path: file }
  }
}

/**
 * The doc files the checker scans: explicit `check.docs` when given, otherwise
 * the editable doc surfaces.
 */
export function checkScope(config) {
  if (config.check.docs.length > 0) return config.check.docs
  return [...config.docs, ...config.docDirs]
}

/**
 * Permission rules for the docs-keeper agent.
 *
 * The shape mirrors the two hand-written agents this replaces: read
 * everything, deny every edit, then allow edits on the configured doc
 * surfaces, then re-deny the read-only doc paths so they stay read-only.
 * Shell is denied except for the read-only git commands and the checker
 * script, matching the hand-written agents.
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {{scriptPath: string, gitCommands?: string[]}} opts
 */
export function buildPermissions(config, opts) {
  const rules = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
  ]

  for (const doc of config.docs) {
    rules.push({ action: "edit", resource: doc, effect: "allow" })
  }
  for (const dir of config.docDirs) {
    rules.push({ action: "edit", resource: `${dir}**`, effect: "allow" })
  }
  for (const doc of config.readOnlyDocs) {
    rules.push({ action: "edit", resource: doc.endsWith("/") ? `${doc}**` : doc, effect: "deny" })
  }

  rules.push({ action: "shell", resource: "*", effect: "deny" })
  for (const cmd of opts.gitCommands ?? ["git status *", "git diff *", "git log *", "git show *"]) {
    rules.push({ action: "shell", resource: cmd, effect: "allow" })
  }
  rules.push({ action: "shell", resource: opts.scriptPath, effect: "allow" })
  rules.push({ action: "shell", resource: `bash ${opts.scriptPath}`, effect: "allow" })

  rules.push({ action: "skill", resource: "*", effect: "allow" })
  rules.push({ action: "subagent", resource: "*", effect: "deny" })

  return rules
}
