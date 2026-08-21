/**
 * `moveNote` and `renameNote` — the same operation, named for the two intents.
 *
 * Re-runnable, which decision 20 makes a requirement rather than a nicety: if the
 * source is gone and the destination is there, the move already happened and the
 * verb finishes the link rewriting instead of failing.
 */
import {slugifyPath} from '@agent-wiki-toolbox/core'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {rewriteLinksInTree} from './rewrite.js'

/** Move a note to a new path, rewriting every link into it. */
export function moveNote(root, {from, to, workspace, dryRun} = {}) {
  return relocate('moveNote', root, {from, to, workspace, dryRun})
}

/** Rename a note within its own folder. Same machinery, narrower intent. */
export function renameNote(root, {path, name, workspace, dryRun} = {}) {
  if (!name || name.includes('/')) {
    throw refuse('renameNote', `"${name}" is a name, not a path — use moveNote to change the folder`)
  }
  const folder = path.split('/').slice(0, -1).join('/')
  const to = folder ? `${folder}/${name}` : name
  return relocate('renameNote', root, {from: path, to, workspace, dryRun})
}

function relocate(verb, root, {from, to, workspace, dryRun}) {
  const context = createContext(root, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  if (!to?.endsWith('.md')) throw refuse(verb, `the destination must be a .md path, got "${to}"`)

  const source = index.get(from)
  const destination = index.get(to)

  // Re-run of a move that already happened: the file is where it should be and
  // only the links are outstanding.
  const alreadyMoved = !source && destination !== undefined
  if (!source && !alreadyMoved) throw refuse(verb, `no note at ${from}`)
  if (source && destination) throw refuse(verb, `${to} already exists`)

  const moved = source ?? destination
  const newSlug = slugifyPath(to)

  // [[conventions]] requires globally unique basenames, and decision 7 makes a
  // duplicate a hard error rather than a warning. Catch it before writing, not
  // after.
  const clash = index.resources.find(
    (resource) => resource.path !== moved.path && resource.slug.split('/').pop() === newSlug.split('/').pop(),
  )
  if (clash) {
    notes.push(
      `the basename "${newSlug.split('/').pop()}" is already used by ${clash.path}; ` +
        'links to it will have to name a folder segment',
    )
  }

  const slugsAfter = index.resources
    .map((resource) => (resource.path === moved.path ? newSlug : resource.slug))
    .sort()

  const unresolved = []
  const oldSlug = slugifyPath(from)
  let currentNote = from

  /**
   * Does this link point at the note that is moving? Resolution answers it in the
   * ordinary case. After a half-finished move it cannot — the file is already gone
   * from where the link says — so the written target is matched against the old
   * slug by the same suffix rule that resolved it before.
   */
  const pointsAtMoved = (node, kind) => {
    if (kind === 'markdown') {
      // A relative path resolves against the note it is written in, never by stem.
      const [path] = node.url.split('#')
      const outcome = index.resolveRelative(node.notePath ?? currentNote, path)
      return outcome.status === 'resolved' && outcome.resource.path === moved.path
    }
    const outcome = index.resolve(node.target)
    if (outcome.status === 'ambiguous') return 'ambiguous'
    if (outcome.status === 'resolved') return outcome.resource.path === moved.path
    // Unresolved: the only way it can concern us is a move already half done.
    if (!alreadyMoved) return false
    const written = slugifyPath(node.target)
    return oldSlug === written || oldSlug.endsWith(`/${written}`)
  }

  // Every note that links to this one, plus the note itself: its own relative
  // markdown links are written from a directory that is about to change. After a
  // half-done move the links resolve to nothing, so the placeholder sites are
  // where the remaining work is.
  const inbound = new Set(alreadyMoved ? [] : index.backlinks(moved.path))
  if (alreadyMoved) {
    for (const placeholder of index.placeholders()) {
      if (oldSlug !== placeholder.target && !oldSlug.endsWith(`/${placeholder.target}`)) continue
      for (const site of placeholder.sites) inbound.add(site.from)
    }
  } else {
    inbound.add(moved.path)
  }

  for (const notePath of [...inbound].sort()) {
    const readFrom = notePath === moved.path && !alreadyMoved ? from : notePath
    if (!context.edit.exists(readFrom)) continue

    currentNote = readFrom
    const tree = parseNote(context, readFrom)
    const {rewritten, unresolved: residue} = rewriteLinksInTree({
      tree,
      notePath: readFrom,
      pointsAtMoved,
      movedTo: to,
      slugsAfter,
    })
    unresolved.push(...residue.map((entry) => ({from: notePath, ...entry})))

    // A file whose links did not change is not rewritten: decision 19 says every
    // write is serialized, not that every file gets written.
    if (rewritten.length === 0) continue
    context.edit.update(readFrom, serialize(tree))
  }

  if (!alreadyMoved) context.edit.move(from, to)
  else notes.push(`${from} was already at ${to}; only the links needed finishing`)

  return finish(verb, context, {unresolved, notes})
}
