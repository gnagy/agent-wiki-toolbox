/**
 * Find the project a command was run inside.
 *
 * Both CLIs used to resolve their paths against the current directory, so they
 * only worked from the project root. `cd site && awt site setup` produced
 *
 *     no site directory at /…/<project>/site/site
 *
 * — a doubled path segment naming a location the user never typed, which is the
 * same signature as `foam lint --workspace docs/wiki` run from inside the wiki.
 * Two tool families, same defect, reported by two wikis a day apart. Walking up
 * is the only fix that stops it recurring: an installed command should not care
 * where in the project you are standing, the way `git` does not.
 *
 * The marker is `<site>/quartz.config.yaml` rather than `quartz.pin`, so a
 * project that has a site but has not pinned a commit is still *found* and gets
 * the specific "no quartz.pin" error instead of a misleading "no site here".
 *
 * This is the legacy walk. The marker every command uses now is the project's
 * `awt.config.mjs`, and the site is a fixed name under the `rootDir` it names;
 * `cli` resolves that and hands every publish command explicit paths. What is left
 * here is the fallback for a project laid out the old way and driven without
 * `cli`, and it looks only for the old shape.
 */

import fs from "node:fs"
import path from "node:path"

/**
 * The nearest ancestor of `from` (including `from` itself) holding
 * `<siteName>/quartz.config.yaml`, or null. Standing inside `site/` or
 * `site/.quartz-src/` finds the project, because the search starts at the
 * directory and walks up rather than looking down.
 */
export function findProjectRoot(siteName = "site", from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(dir, siteName, "quartz.config.yaml"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Resolve the project root or exit with a message naming both what was looked
 * for and the two ways to fix it. `die` is passed in so each CLI keeps its own
 * exit code.
 */
export function requireProjectRoot(die, siteName = "site") {
  const root = findProjectRoot(siteName)
  if (root) {
    if (root !== process.cwd()) console.log(`project: ${root}`)
    return root
  }
  die(
    `no ${siteName}/quartz.config.yaml in ${process.cwd()} or any parent.\n` +
      `Run this from the project root or anywhere inside it, or pass an explicit path.`,
  )
}
