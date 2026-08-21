/**
 * Project configuration for the formatter — the nearest config file, found by
 * walking up.
 *
 * **`markdown-toolbox.config.mjs` is still read**, and not out of nostalgia:
 * a project this toolbox did not write carries one, and we do not get to
 * rename another project's files. New projects write `awt.config.mjs`.
 */
import {readdirSync} from 'node:fs'
import {dirname, join, parse as parsePath} from 'node:path'
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
