/**
 * Where a server started with no explicit path should look, asked again on every
 * call.
 */
import process from 'node:process'

import {resolveLayout} from '@agent-wiki-toolbox/format'

/**
 * The project around `from`, or null when there is none.
 *
 * Null is the whole point. A server that fell back to its own working directory
 * served any directory on the machine as an empty wiki — plausible-looking, since
 * an empty wiki and a directory that is not one report the same zero notes and
 * the same clean graph. Under a user-scoped plugin that server starts in every
 * session, wiki or not, so the fallback stopped being a convenience.
 */
export async function projectTarget(from = process.cwd()) {
  const layout = await resolveLayout(from, {quiet: true})
  if (!layout) return null
  return {
    notesDir: layout.notesDir,
    rootDir: layout.rootDir ?? null,
    // The notes directory is the glob base under a rootDir layout; on a legacy
    // one the config's own directory is, which is what null means downstream.
    schemaGlobBase: layout.legacy ? null : layout.notesDir,
  }
}
