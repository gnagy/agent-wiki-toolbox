#!/usr/bin/env node
// The layer rules of toolbox-decisions 11, enforced rather than reviewed.
//
// Two of these are load-bearing rather than tidy:
//   format must not reach core  — it is what keeps `awt fmt` working on a lone
//                                 CLAUDE.md with no wiki anywhere near it
//   core must not reach mcp/cli — it is what keeps the index a pure function of
//                                 the file tree
import fs from "node:fs"
import path from "node:path"

const ALLOWED = {
  syntax: [],
  core: ["syntax"],
  format: ["syntax"],
  verbs: ["syntax", "core", "format"],
  mcp: ["syntax", "core", "format", "verbs"],
  // cli reaches mcp and publish because decision 22 says there is one binary and
  // everything hangs off it — `awt mcp`, `awt publish`. That is a sideways edge
  // between three packages that sit at the top together, not a downward one:
  // nothing *below* any of them depends on any of them, which is the rule.
  cli: ["syntax", "core", "format", "verbs", "mcp", "publish"],
  publish: ["syntax", "core"],
}

const root = path.join(import.meta.dirname, "..", "packages")
const SCOPE = "@agent-wiki-toolbox/"
let bad = 0

for (const pkg of fs.readdirSync(root)) {
  const manifest = path.join(root, pkg, "package.json")
  if (!fs.existsSync(manifest)) continue
  const allowed = ALLOWED[pkg]
  if (!allowed) { console.error(`unknown package: ${pkg} — add it to ALLOWED or delete it`); bad++; continue }
  const deps = Object.keys(JSON.parse(fs.readFileSync(manifest, "utf8")).dependencies ?? {})
  for (const dep of deps.filter((d) => d.startsWith(SCOPE)).map((d) => d.slice(SCOPE.length))) {
    if (!allowed.includes(dep)) {
      console.error(`${pkg} must not depend on ${dep}`)
      bad++
    }
  }
}

if (bad) {
  console.error(`\n${bad} layering violation${bad === 1 ? "" : "s"}. The dependency graph is the architecture.`)
  process.exit(1)
}
console.log(`layering ok — ${Object.keys(ALLOWED).length} packages`)
