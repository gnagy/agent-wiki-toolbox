/**
 * The index is a pure function of the file tree, memoized on disk and keyed by
 * content. Walking and stat-ing 300 notes costs about 1% of parsing them, so
 * nothing watches the tree.
 *
 * Correct after an editor save, an agent's `Write`, a `git checkout` or a rebase,
 * because nothing had to be watching when the change happened.
 *
 * **The cache never lives in the wiki.** Wikis belong to other projects, and writing
 * a dot-directory into one is writing to a repo that is not ours. It goes under
 * `$XDG_CACHE_HOME`, keyed by the workspace's real path.
 */
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

/**
 * Bump this whenever the record shape or the parse semantics change. A cache is a
 * memo of *this* code's output; served to a later version it is a wrong answer
 * delivered fast, which is the worst kind.
 */
export const INDEX_VERSION = 2

export function hashSource(source) {
  return createHash('sha256').update(source).digest('hex')
}

export function cacheDirectory() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'agent-wiki-toolbox')
}

export function cachePathFor(notesDir) {
  let real = notesDir
  try {
    real = realpathSync(notesDir)
  } catch {
    // A notes directory that cannot be resolved cannot be cached against; the key is still
    // stable for the string we were given.
  }
  return join(cacheDirectory(), `${createHash('sha256').update(real).digest('hex').slice(0, 32)}.json`)
}

/** The cached entries for a workspace, or an empty map for anything unusable. */
export function readCache(notesDir) {
  try {
    const cached = JSON.parse(readFileSync(cachePathFor(notesDir), 'utf8'))
    if (cached.version !== INDEX_VERSION) return new Map()
    return new Map(Object.entries(cached.entries))
  } catch {
    // Advisory by design: a missing, truncated or half-written cache is a cold
    // start, never a failure.
    return new Map()
  }
}

/**
 * Write via a temporary file and rename, because two processes legitimately write
 * this at once — an agent's MCP call during a site build.
 */
export function writeCache(notesDir, entries) {
  const path = cachePathFor(notesDir)
  const temporary = `${path}.${process.pid}.tmp`
  mkdirSync(cacheDirectory(), {recursive: true})
  try {
    writeFileSync(temporary, JSON.stringify({version: INDEX_VERSION, notesDir, entries: Object.fromEntries(entries)}))
    renameSync(temporary, path)
  } catch {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary)
      } catch {
        // Nothing to do: a cache we could not write is a cache we do without.
      }
    }
  }
}
