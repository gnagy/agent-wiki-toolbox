/**
 * Load a package out of the project's own Quartz clone.
 *
 * These CLIs carry no dependencies. What they need — a hast parser, a YAML
 * parser — Quartz already depends on, and the clone is right there. Loading it
 * from the clone rather than vendoring a second copy means the HTML is read by
 * the same parser that wrote it, and the config by the same parser Quartz reads
 * it with: no second implementation free to disagree.
 *
 * Resolution goes through the package's own manifest rather than bare `import`,
 * because these files run from ~/.local/lib, where node's resolution would look
 * beside the *installed tool* and find nothing.
 */

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export async function loadFromQuartz(quartz, pkg, die) {
  const modules = path.join(quartz, "node_modules")
  const manifest = path.join(modules, pkg, "package.json")
  if (!fs.existsSync(manifest)) {
    die(
      `cannot find ${pkg} in ${modules}\n` +
        "It ships as a Quartz dependency, so this usually means the Quartz clone is\n" +
        "missing or its install did not finish. Run bootstrap-quartz.",
    )
  }
  const meta = JSON.parse(fs.readFileSync(manifest, "utf8"))
  const e = meta.exports
  const rel =
    (typeof e === "string" ? e : null) ??
    (typeof e?.["."] === "string" ? e["."] : null) ??
    e?.["."]?.import ??
    e?.["."]?.default ??
    meta.main ??
    "index.js"
  return import(pathToFileURL(path.join(modules, pkg, rel)).href)
}
