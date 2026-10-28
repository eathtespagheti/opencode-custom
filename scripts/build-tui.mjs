// Builds the TUI half of the plugin.
//
// OpenCode only runs its Solid JSX transform on .jsx/.tsx files **outside**
// node_modules. This package is installed into node_modules, so a `./tui`
// entrypoint that still contains JSX is loaded by Bun with its default React
// JSX runtime and dies with "Cannot find package 'react'".
//
// The fix is to publish compiled JS. We use the same transform OpenCode uses
// for local plugins (babel-preset-solid, universal renderer, moduleName
// "@opentui/solid"), so the output imports only modules the host provides as
// virtual modules: @opentui/solid, solid-js and @opencode/plugin/tui.
//
// Run `npm run build` after editing tui.jsx and commit the generated tui.js.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const sourcePath = join(root, "tui.jsx")
const outputPath = join(root, "tui.js")

const source = await readFile(sourcePath, "utf8")
const result = await transformAsync(source, {
  filename: sourcePath,
  configFile: false,
  babelrc: false,
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }]],
})

if (!result?.code) throw new Error("babel produced no output")

const header = `// GENERATED FILE — do not edit.
// Source: tui.jsx. Regenerate with \`npm run build\`.
//
// OpenCode does not apply its Solid JSX transform to files inside
// node_modules, so the installed package must ship compiled JS. The imports
// below (@opentui/solid, solid-js, @opencode/plugin/tui) are provided by the
// OpenCode host as virtual modules.
`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, header + result.code)
console.log(`built ${outputPath}`)
