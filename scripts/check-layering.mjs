#!/usr/bin/env bun
// The layer rules, enforced.
//
// Two of these are load-bearing rather than tidy:
//   format must not reach core  — it is what keeps `awt fmt` working on a lone
//                                 CLAUDE.md with no wiki anywhere near it
//   core must not reach mcp/cli — it is what keeps the index a pure function of
//                                 the file tree
//
// **It reads the imports, not the manifests.** An earlier version compared
// `dependencies` against the allow-list and passed while `verbs` imported `syntax`
// without declaring it: npm workspace hoisting resolves a specifier whether or not
// the package.json names it, so the single edit that would break a layer — writing
// one `import` line — was exactly the edit the check could not see. A manifest is
// a claim; the import graph is the architecture.
import fs from "node:fs"
import path from "node:path"

const ALLOWED = {
  syntax: [],
  core: ["syntax"],
  format: ["syntax"],
  verbs: ["syntax", "core", "format"],
  mcp: ["syntax", "core", "format", "verbs"],
  // cli reaches mcp and publish because there is one binary: `awt mcp`,
  // `awt publish`. That is a sideways edge between three packages at the top,
  // not a downward one; nothing below any of them depends on any of them.
  cli: ["syntax", "core", "format", "verbs", "mcp", "publish"],
  publish: ["syntax", "core"],
}

const root = path.join(import.meta.dirname, "..", "packages")
const SCOPE = "@agent-wiki-toolbox/"
const SOURCE = /\.(m|c)?js$/

// A specifier in an import, an export-from, a dynamic import or a require — and
// nowhere else, so a package named in a comment is prose rather than an edge.
const SPECIFIER = new RegExp(
  `(?:from|import|require)\\s*\\(?\\s*['"](${SCOPE.replace("/", "\\/")}[a-z-]+)['"]`,
  "g",
)

/** Every source file under `dir`, node_modules excluded. */
function* sources(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(full)
    else if (SOURCE.test(entry.name)) yield full
  }
}

let bad = 0
const report = (message) => { console.error(message); bad++ }

for (const pkg of fs.readdirSync(root)) {
  const manifest = path.join(root, pkg, "package.json")
  if (!fs.existsSync(manifest)) continue
  const allowed = ALLOWED[pkg]
  if (!allowed) { report(`unknown package: ${pkg}; add it to ALLOWED or delete it`); continue }

  const declared = new Set(
    Object.keys(JSON.parse(fs.readFileSync(manifest, "utf8")).dependencies ?? {})
      .filter((name) => name.startsWith(SCOPE))
      .map((name) => name.slice(SCOPE.length)),
  )
  for (const dep of declared) {
    if (!allowed.includes(dep)) report(`${pkg}/package.json declares ${dep}, which it must not depend on`)
  }

  const imported = new Map()
  for (const file of sources(path.join(root, pkg))) {
    const source = fs.readFileSync(file, "utf8")
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      const dep = specifier.slice(SCOPE.length)
      if (!imported.has(dep)) imported.set(dep, path.relative(root, file))
    }
  }

  for (const [dep, where] of [...imported].sort()) {
    if (dep === pkg) continue // a package naming itself resolves to its own index
    if (!allowed.includes(dep)) report(`${where} imports ${dep}; ${pkg} must not depend on it`)
    else if (!declared.has(dep)) report(`${where} imports ${dep}, which ${pkg}/package.json does not declare`)
  }

  // Not a violation — hoisting makes it harmless — but a manifest that claims an
  // edge the code does not have is a wrong map of the architecture.
  for (const dep of declared) {
    if (!imported.has(dep)) console.warn(`note: ${pkg}/package.json declares ${dep} and imports nothing from it`)
  }
}

if (bad) {
  console.error(`\n${bad} layering violation${bad === 1 ? "" : "s"}. The dependency graph is the architecture.`)
  process.exit(1)
}
console.log(`layering ok, ${Object.keys(ALLOWED).length} packages`)
