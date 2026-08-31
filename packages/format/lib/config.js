/**
 * Project configuration — the nearest config file, found by walking up.
 *
 * It started as the formatter's and is now the project's: one file per project,
 * read by whichever subcommand cares. The formatter reads `settings`, `plugins`,
 * `schemas` and `validateLinks`; `awt serve` reads `serve`, so a wiki keeps the
 * same ports every run instead of having them retyped.
 *
 *     export default {
 *       serve: {port: 8101},          // wsPort defaults to port + 100
 *       settings: {bullet: '-'},
 *     }
 *
 * Keys nothing recognises are inert, which is what lets one file serve several
 * subcommands without any of them validating the others' half.
 *
 * **`markdown-toolbox.config.mjs` is still read**, and not out of nostalgia: a
 * project this toolbox did not write carries one, and renaming another project's
 * files is not ours to do. New projects write `awt.config.mjs`.
 */
import {existsSync, readdirSync, statSync} from 'node:fs'
import {dirname, join, parse as parsePath, relative, resolve as resolvePath} from 'node:path'
import {pathToFileURL} from 'node:url'
import process from 'node:process'

export const CONFIG_NAMES = [
  'awt.config.mjs',
  'awt.config.js',
  'markdown-toolbox.config.mjs',
  'markdown-toolbox.config.js',
  '.mdfmtrc.mjs',
]

/** Ignore files honoured while walking a directory, newest name first. */
export const IGNORE_NAMES = ['.awtignore', '.mdfmtignore']

/**
 * Which of `IGNORE_NAMES` a run should honour.
 *
 * unified-engine takes exactly one `ignoreName`, and we honour two — a project
 * that already has a `.mdfmtignore` is a project we may not rename a file in — so
 * the name is chosen rather than assumed. Passing only the newest one silently
 * reformatted every file such a project had excluded, which is the one thing the
 * second name exists to prevent.
 *
 * The search mirrors unified-engine's own: from each place the run was pointed at,
 * up through every parent to the filesystem root, and the **nearest** directory
 * holding either name decides. Where one directory holds both, the newer name
 * wins.
 */
export function detectIgnoreName(roots = [], cwd = process.cwd()) {
  const starts = new Set([cwd])
  for (const root of roots) {
    const path = resolvePath(cwd, root)
    starts.add(isDirectory(path) ? path : dirname(path))
  }

  const found = new Set()
  for (const start of starts) {
    let dir = start
    for (;;) {
      const name = IGNORE_NAMES.find((candidate) => existsSync(join(dir, candidate)))
      if (name) {
        found.add(name)
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  return IGNORE_NAMES.find((name) => found.has(name)) ?? IGNORE_NAMES[0]
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Serialiser settings. Pinned rather than left to remark's defaults so a first run
 * on an existing project produces a diff you chose instead of one you discovered.
 * Override any of them through `settings` in the project config.
 */
export const DEFAULT_SETTINGS = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
}

/**
 * Find the nearest project config by walking up from `from`. Returns the loaded
 * config plus the path it came from, or an empty config if there is none.
 */
export async function loadProjectConfig(from = process.cwd()) {
  const {root} = parsePath(from)
  let dir = from

  for (;;) {
    let entries
    try {
      entries = new Set(readdirSync(dir))
    } catch {
      entries = new Set()
    }

    const name = CONFIG_NAMES.find((candidate) => entries.has(candidate))
    if (name) {
      const filepath = join(dir, name)
      const module = await import(pathToFileURL(filepath).href)
      return {config: module.default ?? {}, filepath}
    }

    if (dir === root) return {config: {}, filepath: null}
    const parent = dirname(dir)
    if (parent === dir) return {config: {}, filepath: null}
    dir = parent
  }
}

/** Thrown by `resolveProjectConfig` when the paths disagree about which config governs. */
export const AMBIGUOUS_CONFIG = 'AWT_AMBIGUOUS_CONFIG'

/**
 * The config for a run, found from **what the run was pointed at** rather than
 * from where it was started.
 *
 * The walk used to begin at the cwd, so `awt fmt wiki/note.md` from a repo root
 * formatted the note with the *repo's* config while the same file formatted from
 * inside the wiki used the *wiki's*. Same file, different bytes, decided by where
 * the shell happened to be standing, and nothing said so. Every other formatter in
 * this family — remark, prettier, eslint — resolves from the file, and this now
 * matches them.
 *
 * unified-engine takes one processor, so a run has exactly one config. Where the
 * paths disagree about which one that is, the run is **refused** rather than
 * settled by argument order: picking the first is the silent wrong answer this
 * function exists to remove. Formatting them in separate runs, or naming the
 * governing wiki with `--workspace`, both say which was meant.
 */
export async function resolveProjectConfig(roots = [], cwd = process.cwd()) {
  const starts = roots.length
    ? roots.map((root) => {
        const path = resolvePath(cwd, root)
        return isDirectory(path) ? path : dirname(path)
      })
    : [cwd]

  const found = new Map()
  for (const start of starts) {
    const loaded = await loadProjectConfig(start)
    found.set(loaded.filepath, loaded)
  }

  if (found.size > 1) {
    const names = [...found.keys()].map((path) => path ?? '(no config)').sort()
    const error = new Error(
      `these paths are governed by different project configs, and one run has one config: ${names.join(', ')}.\n` +
        '  Format them in separate runs, or pass --workspace to name the wiki that governs.',
    )
    error.code = AMBIGUOUS_CONFIG
    throw error
  }

  return [...found.values()][0]
}

/**
 * Anchor `schemas` to the directory of the config file that declared it.
 *
 * The associations are written by hand next to the config — `docs/wiki/meta/**` in
 * a repo-root `awt.config.mjs` — and the only base that makes those globs mean the
 * same thing from every working directory is the config's own directory. Without
 * this they were matched against wherever the run happened to be rooted, so the
 * schemas fired from a repo root, and **silently matched nothing** from inside the
 * wiki, from `awt fmt -w`, and from the MCP server — which roots every run at the
 * wiki and is how most notes are written. Nothing said so: the run reported the
 * config it had loaded and zero problems, which reads as "the schemas passed".
 *
 * The two halves take different bases because `remark-lint-frontmatter-schema`
 * uses different ones:
 *
 * - **Globs** are matched against `vFile.path`, which unified-engine writes
 *   relative to the run's `cwd` — so they are rewritten relative to that.
 * - **The schema path** is the plugin's map key, which it joins onto its own idea
 *   of the project root: the nearest `.remarkrc`, and `process.cwd()` when there is
 *   none. `awt` ships its config so projects need no `.remarkrc`, so that is the
 *   cwd — and a project that adds one moves the base out from under this. The test
 *   `schemas fire wherever the run is rooted` is what catches it.
 *
 * Both are derived from `configDir`, so what a glob names does not depend on where
 * anything was started.
 */
export function anchorSchemas(config = {}, configPath, cwd = process.cwd()) {
  if (!config.schemas || !configPath) return config

  const configDir = dirname(configPath)
  const anchored = {}

  for (const [schemaPath, globs] of Object.entries(config.schemas)) {
    const key = relative(process.cwd(), resolvePath(configDir, schemaPath))
    anchored[key] = Array.isArray(globs)
      ? globs.map((glob) =>
          typeof glob === 'string' ? relative(cwd, resolvePath(configDir, glob)) : glob,
        )
      : globs
  }

  return {...config, schemas: anchored}
}
