/**
 * `moveNote` and `renameNote` — the same operation, named for the two intents.
 *
 * Re-runnable, which decision 20 makes a requirement rather than a nicety: if the
 * source is gone and the destination is there, the move already happened and the
 * verb finishes the link rewriting instead of failing.
 */
import {createResolver, slugifyPath} from '@agent-wiki-toolbox/core'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {ambiguousStems, rebaseRelativeLinks, rewriteLinksInTree} from './rewrite.js'

/** Move a note to a new path, rewriting every link into it. */
export function moveNote(notesDir, {from, to, workspace, dryRun} = {}) {
  return relocate('moveNote', notesDir, {from, to, workspace, dryRun})
}

/** Rename a note within its own folder. Same machinery, narrower intent. */
export function renameNote(notesDir, {path, name, workspace, dryRun} = {}) {
  if (!name || name.includes('/')) {
    throw refuse('renameNote', `"${name}" is a name, not a path — use moveNote to change the folder`)
  }
  const folder = path.split('/').slice(0, -1).join('/')
  const to = folder ? `${folder}/${name}` : name
  return relocate('renameNote', notesDir, {from: path, to, workspace, dryRun})
}

function relocate(verb, notesDir, {from, to, workspace, dryRun}) {
  const context = createContext(notesDir, {workspace, dryRun})
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

  // The wiki this move *produces*, and its resolver. A link is written as the
  // shortest form that resolves to the note, and "resolves" has to mean in the tree
  // that will exist — the note is not where it used to be, and a form checked
  // against the old tree can name something that has moved away.
  const after = index.resources.map((resource) =>
    resource.path === moved.path ? {...resource, path: to, slug: newSlug} : resource,
  )
  const {resolve: resolveAfter} = createResolver(after)

  // [[conventions]] requires globally unique basenames and decision 7 makes a
  // duplicate a hard error rather than a guess — so a move that *creates* one is
  // refused, the way `splitByHeading` refuses the same thing. The comment here used
  // to say exactly this while the code pushed a note and carried on.
  //
  // Refused rather than reported because of *whose* links break: this verb rewrites
  // the links pointing at the note it moved, and the ones that break are the other
  // ones — every note that already wrote `[[stem]]` about the note whose name this
  // one just took. Those are not this move's to rewrite, and nothing would have
  // told anyone until the next `awt check`.
  const wasAmbiguous = ambiguousStems(index.resources, index.resolve)
  const introduced = [...ambiguousStems(after, resolveAfter)].filter((stem) => !wasAmbiguous.has(stem)).sort()
  if (introduced.length > 0) {
    const matched = introduced
      .map((stem) => `[[${stem}]] (${resolveAfter(stem).candidates.map((c) => c.path).join(' and ')})`)
      .join(', ')
    throw refuse(
      verb,
      `${to} takes a name already in the wiki: ${matched}. Every note already linking by that bare ` +
        'stem would break, and those are not this move to rewrite. Nothing was written',
    )
  }

  // An ambiguity that was already there is not this move's doing, and explains why
  // the links it rewrites come out naming a folder segment.
  if (wasAmbiguous.has(newSlug.split('/').pop())) {
    notes.push(
      `[[${newSlug.split('/').pop()}]] already matched more than one note, so links to this one ` +
        'name a folder segment',
    )
  }

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

  // Every note that links to this one, plus the note itself: all of its own
  // relative markdown links are written from a directory that is about to change,
  // and get rebased on the destination. After a half-done move the file already
  // sits at its new path with its links rebased, and what is left is the inbound
  // ones — which resolve to nothing now, so the placeholder sites are the work.
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
    const isMoved = notePath === moved.path && !alreadyMoved
    const readFrom = isMoved ? from : notePath
    if (!context.edit.exists(readFrom)) continue

    currentNote = readFrom
    const tree = parseNote(context, readFrom)
    const links = rewriteLinksInTree({
      tree,
      notePath: readFrom,
      pointsAtMoved,
      movedTo: to,
      resolveAfter,
      rebasing: isMoved,
    })
    const rewritten = [...links.rewritten]
    const residue = [...links.unresolved]

    if (isMoved) {
      const rebased = rebaseRelativeLinks({
        tree,
        from,
        to,
        resolveRelative: (notePath, target) => index.resolveRelative(notePath, target),
      })
      rewritten.push(...rebased.rewritten)
      residue.push(...rebased.unresolved)
    }

    unresolved.push(...residue.map((entry) => ({from: notePath, ...entry})))

    // A file whose links did not change is not rewritten: decision 19 says every
    // write is serialized, not that every file gets written.
    if (rewritten.length === 0) continue
    context.edit.update(readFrom, serialize(tree))
  }

  // The moved note's rewrite and its move are one operation, keyed by one path:
  // `edit.move` picks up whatever was staged for `from` and carries it across.
  if (!alreadyMoved) context.edit.move(from, to)
  else notes.push(`${from} was already at ${to}; only the links needed finishing`)

  return finish(verb, context, {unresolved, notes})
}
