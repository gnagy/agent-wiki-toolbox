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
import {dirname, join, parse as parsePath, resolve as resolvePath} from 'node:path'
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
