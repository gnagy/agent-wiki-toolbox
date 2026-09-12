/**
 * Load a package out of the project's own Quartz install.
 *
 * These CLIs carry no dependencies. What they need — a hast parser, a YAML
 * parser — Quartz already depends on, and the install is right there. Loading
 * it from there rather than vendoring a second copy means the HTML is read by
 * the same parser that wrote it, and the config by the same parser Quartz reads
 * it with: no second implementation free to disagree.
 *
 * Resolution goes through the package's own manifest rather than bare `import`,
 * because these files run from a plugin install, where node's resolution would
 * look beside the *installed tool* and find nothing.
 *
 * **Checked nested-then-hoisted, the same order node's own `require` would.**
 * `quartz` is a bun-installed git dependency of the site's own package.json,
 * and bun hoists its dependencies to the site's top-level `node_modules`
 * whenever nothing conflicts — verified empirically: `yaml` lands at
 * `site/node_modules/yaml`, not `site/node_modules/quartz/node_modules/yaml`.
 * Trying the nested path first costs nothing and keeps this correct if a
 * future version ever needs bun to isolate one package instead.
 */

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

function manifestPath(modules, pkg) {
  const manifest = path.join(modules, pkg, "package.json")
  return fs.existsSync(manifest) ? manifest : null
}

export async function loadFromQuartz(quartz, pkg, die) {
  const nested = path.join(quartz, "node_modules")
  const hoisted = path.join(path.dirname(quartz), "node_modules")
  const modules = manifestPath(nested, pkg) ? nested : hoisted
  const manifest = manifestPath(modules, pkg)
  if (!manifest) {
    die(
      `cannot find ${pkg} in ${nested} or ${hoisted}\n` +
        "It ships as a Quartz dependency, so this usually means the Quartz install is\n" +
        "missing or did not finish. Run `awt site setup`.",
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
