/**
 * Where a project keeps its wiki — every directory the toolbox needs, derived from
 * one name ([[toolbox-decisions]] 38).
 *
 * A wiki used to be spread over the repo root: notes in `docs/wiki`, the site in
 * `site/`, schemas in `.remark/`, the inbox in `docs/wiki-inbox/`, and the notes
 * path copied into five files that each had to agree. Now the project names one
 * directory, `rootDir` in `awt.config.mjs`, and the rest are fixed names inside
 * it:
 *
 *     <rootDir>/notes      the wiki root — an OKF bundle and nothing else
 *     <rootDir>/site       quartz.config.yaml, quartz.pin, and the build's leavings
 *     <rootDir>/schemas    front-matter schemas
 *     <rootDir>/inbox      the interop inbox, outside the notes so it is never indexed
 *
 * `rootDir` defaults to `wiki`, resolved against the config file's directory, so a
 * project laid out the default way writes nothing. The config at the repo root is
 * the marker the tools walk up to from any directory inside the project — which is
 * why it is at the root rather than inside the home: once the home is configurable
 * there is no fixed directory name left to look for.
 *
 * **The names end in `Dir`, all of them** (row 39). The notes directory was called
 * `root` on every surface, and `rootDir` naming the *home* would have put two roots
 * a level apart in front of every agent. So the surface says `notesDir`, and `root`
 * is not the name of any directory here.
 *
 * **The old layout still resolves.** A config with no `rootDir` whose directory
 * holds `docs/wiki` and no `wiki/` is read as `docs/wiki` + `site` + `.remark` +
 * `docs/wiki-inbox`, and so is a project with no config at all but a
 * `site/quartz.config.yaml` marker. A depended-on wiki has to keep building while
 * its sibling migrates, so a flag day is exactly what the fallback prevents. It
 * says so once on stderr, because a fallback nobody can see is a layout nobody
 * migrates.
 */
import {existsSync} from 'node:fs'
import {dirname, join, resolve as resolvePath} from 'node:path'
import process from 'node:process'

import {loadProjectConfig} from './config.js'

export const DEFAULT_ROOT_DIR = 'wiki'

/** The fixed names under the home. Not configurable, and not written anywhere. */
export const HOME_LAYOUT = {
  notesDir: 'notes',
  siteDir: 'site',
  schemasDir: 'schemas',
  inboxDir: 'inbox',
}

/** The layout every project had before `rootDir` existed. */
export const LEGACY_LAYOUT = {
  notesDir: 'docs/wiki',
  siteDir: 'site',
  schemasDir: '.remark',
  inboxDir: 'docs/wiki-inbox',
}

/** Legacy marker: the file `awt` walked up to before the config was the marker. */
const LEGACY_MARKER = join('site', 'quartz.config.yaml')

let warned = false
function warnLegacy(projectDir) {
  if (warned || process.env.AWT_QUIET_LEGACY) return
  warned = true
  process.stderr.write(
    `awt: ${projectDir} is laid out the old way (docs/wiki + site). It still works.\n` +
      '  The current layout is one home directory, wiki/ by default, holding notes/, site/, schemas/ and inbox/;\n' +
      '  rootDir in awt.config.mjs names it.\n',
  )
}

/**
 * The layout a config describes, given the config and where it was read from.
 *
 *   {projectDir, rootDir, notesDir, siteDir, schemasDir, inboxDir, legacy, configPath}
 *
 * Every path absolute. `legacy` is true when the old shape was recognised;
 * `rootDir` is then null, because that layout has no single home.
 */
export function layoutFrom(config = {}, configPath, projectDir = configPath ? dirname(configPath) : process.cwd()) {
  const explicit = config.rootDir !== undefined && config.rootDir !== null

  if (!explicit && isLegacyProject(projectDir)) {
    return {
      projectDir,
      configPath: configPath ?? null,
      rootDir: null,
      legacy: true,
      ...absolute(projectDir, LEGACY_LAYOUT),
    }
  }

  const rootDir = resolvePath(projectDir, explicit ? String(config.rootDir) : DEFAULT_ROOT_DIR)
  return {
    projectDir,
    configPath: configPath ?? null,
    rootDir,
    legacy: false,
    ...absolute(rootDir, HOME_LAYOUT),
  }
}

function absolute(base, names) {
  return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, join(base, name)]))
}

/** The old shape: `docs/wiki` present and no `wiki/` home beside it. */
function isLegacyProject(projectDir) {
  return existsSync(join(projectDir, LEGACY_LAYOUT.notesDir)) && !existsSync(join(projectDir, DEFAULT_ROOT_DIR))
}

/**
 * The nearest ancestor of `from` (itself included) holding a project config, else
 * the legacy `site/quartz.config.yaml` marker. Returns `{projectDir, configPath}`
 * or null when neither is found — which is what a bare wiki directory with no
 * project around it looks like, and is not an error.
 */
export async function findProject(from = process.cwd()) {
  const loaded = await loadProjectConfig(from)
  if (loaded.filepath) return {projectDir: dirname(loaded.filepath), configPath: loaded.filepath, config: loaded.config}

  let dir = resolvePath(from)
  for (;;) {
    if (existsSync(join(dir, LEGACY_MARKER))) return {projectDir: dir, configPath: null, config: {}}
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The layout for the project around `from`, or null when there is no project.
 * This is what every command that has not been handed an explicit path calls.
 */
export async function resolveLayout(from = process.cwd(), {quiet = false} = {}) {
  const project = await findProject(from)
  if (!project) return null
  const layout = layoutFrom(project.config, project.configPath, project.projectDir)
  if (layout.legacy && !quiet) warnLegacy(project.projectDir)
  return layout
}
