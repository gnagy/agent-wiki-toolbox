/**
 * `moveNotes`, and `moveNote` and `renameNote` as a plan of one pair.
 *
 * **A plan is resolved against the tree it produces, once.** Moving notes one at
 * a time rewrites every link against a layout that is only part of the way there:
 * a qualifier chosen because it was unique at that moment stops being unique when
 * a later move lands a same-named note beside it, and one dropped because it was
 * not needed yet is needed again a move later. Each rewrite is correct for the
 * tree it saw, and the sequence is wrong. So the whole plan is validated, the
 * final layout computed, and every link written once against that layout — the
 * rule *Applying operations as a set* names for a batch, taken across notes.
 *
 * Re-runnable per pair: a source that is gone with its destination there is a
 * move that already happened, and the verb finishes its links instead of failing.
 */
import {existsSync, readdirSync, rmdirSync, rmSync, statSync} from 'node:fs'
import {join} from 'node:path'

import {createResolver, slugifyPath} from '@agent-wiki-toolbox/core'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'
import {ambiguousStems, retargetLinksInTree} from './rewrite.js'

/** Move every note in a plan of `{from, to}` pairs, rewriting links against the end state. */
export function moveNotes(notesDir, {pairs, workspace, dryRun} = {}) {
  return relocate('moveNotes', notesDir, {pairs, workspace, dryRun})
}

/** Move a note to a new path, rewriting every link into it. */
export function moveNote(notesDir, {from, to, workspace, dryRun} = {}) {
  return relocate('moveNote', notesDir, {pairs: [{from, to}], workspace, dryRun})
}

/** Rename a note within its own folder. Same machinery, narrower intent. */
export function renameNote(notesDir, {path, name, workspace, dryRun} = {}) {
  if (!name || name.includes('/') || !name.endsWith('.md')) {
    throw refuse('renameNote', `the new name must be <new-basename.md>, got "${name}"; moveNote changes the folder`)
  }
  const folder = path.split('/').slice(0, -1).join('/')
  const to = folder ? `${folder}/${name}` : name
  return relocate('renameNote', notesDir, {pairs: [{from: path, to}], workspace, dryRun})
}

function relocate(verb, notesDir, {pairs, workspace, dryRun}) {
  validatePlan(verb, pairs)

  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  // Still to move, keyed by where the index holds the note now; and the ones a
  // previous run already moved, whose inbound links are what is left.
  const moves = new Map()
  const finished = []
  for (const {from, to} of pairs) {
    const source = index.get(from)
    const destination = index.get(to)
    if (!source && !destination) throw refuse(verb, `no note at ${from}`)
    if (source && destination) throw refuse(verb, `${to} already exists`)
    if (source) moves.set(from, to)
    else finished.push({from, to, oldSlug: slugifyPath(from)})
  }
  const finalPath = (path) => moves.get(path) ?? path

  // The wiki this plan *produces*, and its resolver. A link is written as the
  // shortest form that resolves to its note in the tree that will exist — never in
  // the tree as it is, and never in one on the way there.
  const after = index.resources.map((resource) => {
    const to = moves.get(resource.path)
    return to ? {...resource, path: to, slug: slugifyPath(to)} : resource
  })
  const {resolve: resolveAfter} = createResolver(after)

  // A plan that makes a bare stem ambiguous is refused, as `splitByHeading`
  // refuses the same thing. The links in the wiki today could be rewritten, but
  // `[[stem]]` is how the next note will be written, by someone who has no idea a
  // second note took the name.
  const wasAmbiguous = ambiguousStems(index.resources, index.resolve)
  const introduced = [...ambiguousStems(after, resolveAfter)].filter((stem) => !wasAmbiguous.has(stem)).sort()
  if (introduced.length > 0) {
    const landing = [...moves.values()].filter((to) => introduced.includes(slugifyPath(to).split('/').pop()))
    const matched = introduced
      .map((stem) => `[[${stem}]] (${resolveAfter(stem).candidates.map((c) => c.path).join(' and ')})`)
      .join(', ')
    throw refuse(
      verb,
      `${landing.join(', ')} ${landing.length === 1 ? 'takes' : 'take'} a name already in the wiki: ${matched}. ` +
        'Every note linking by that bare stem would stop resolving. Nothing was written',
    )
  }

  // An ambiguity that was already there is not this plan's doing, and explains why
  // the links it rewrites come out naming a folder segment.
  for (const to of moves.values()) {
    const stem = slugifyPath(to).split('/').pop()
    if (wasAmbiguous.has(stem)) {
      notes.push(`[[${stem}]] already matched more than one note, so links to ${to} name a folder segment`)
    }
  }

  // The notes to read: every moved note, whose own relative links are written from
  // a folder that is changing; every note linking into one; the placeholder sites
  // left by a move already done; and every note holding a link whose meaning the
  // plan changes although it points at nothing that moves — `[[workspaces/x]]`,
  // unique today, ambiguous once another `workspaces/x` lands elsewhere.
  const scan = new Set()
  for (const path of moves.keys()) {
    scan.add(path)
    for (const inbound of index.backlinks(path)) scan.add(inbound)
  }
  for (const placeholder of index.placeholders()) {
    if (!finished.some(({oldSlug}) => matchesSlug(oldSlug, placeholder.target))) continue
    for (const site of placeholder.sites) scan.add(site.from)
  }
  const collateral = new Set()
  for (const edge of index.edges) {
    if (edge.kind === 'markdown' || !edge.target) continue
    const outcome = resolveAfter(edge.target)
    if (outcome.status === 'resolved' && outcome.resource.path === finalPath(edge.to)) continue
    if (!moves.has(edge.to)) collateral.add(edge.from)
    scan.add(edge.from)
  }

  const unresolved = []
  for (const notePath of [...scan].sort()) {
    if (!context.edit.exists(notePath)) continue
    const tree = parseNote(context, notePath)
    const links = retargetLinksInTree({
      tree,
      notePath,
      destination: finalPath(notePath),
      resolveBefore: index.resolve,
      resolveRelativeBefore: index.resolveRelative,
      resolveAfter,
      finalPath,
      finished,
    })
    unresolved.push(...links.unresolved.map((entry) => ({from: notePath, ...entry})))

    // A file whose links did not change is not rewritten.
    if (links.rewritten.length === 0) continue
    context.edit.update(notePath, serialize(tree))
  }

  // A link the plan leaves with no form that reaches its note is a note the plan
  // makes unreachable, and landing the rest would be landing that. Refused while
  // nothing is written.
  const stranded = unresolved.filter((entry) => entry.reason === 'no unambiguous form for the new path')
  if (stranded.length > 0) {
    const named = [...new Set(stranded.flatMap((entry) => entry.candidates))].sort()
    throw refuse(
      verb,
      `no link could reach ${named.join(', ')} after this plan: every form of the name would match more ` +
        'than one note. Nothing was written',
      {unresolved: stranded},
    )
  }

  if (collateral.size > 0) {
    notes.push(
      `rewrote links that the plan would otherwise have pointed elsewhere, in notes it neither moves nor ` +
        `points at: ${[...collateral].sort().join(', ')}`,
    )
  }

  // A moved note's rewrite and its move are one operation, keyed by one path:
  // `edit.move` picks up whatever was staged for the source and carries it across.
  for (const [from, to] of moves) context.edit.move(from, to)
  for (const {from, to} of finished) notes.push(`${from} was already at ${to}; only the links needed finishing`)

  return finish(verb, context, {
    unresolved,
    notes,
    settle: (applied) => settleFolders(notesDir, {moves, applied, dryRun: context.dryRun}),
  })
}

/**
 * What a plan must be before anything is read. A chain or a swap is refused, not
 * ordered: after a partial run, a re-run finds a note at `b` and nothing on disk
 * says whether it is the one that was there or the one that arrived. Two plans
 * say what one ambiguous plan cannot.
 */
function validatePlan(verb, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw refuse(verb, 'a move needs at least one {from, to} pair')
  for (const {from, to} of pairs) {
    if (typeof from !== 'string' || !from) throw refuse(verb, `every pair needs a from, got ${JSON.stringify(from)}`)
    if (typeof to !== 'string' || !to.endsWith('.md')) {
      throw refuse(verb, `the destination must be a .md path, got "${to}"`)
    }
  }

  const twice = (values) => values.filter((value, at) => values.indexOf(value) !== at)
  const sources = pairs.map((pair) => pair.from)
  const destinations = pairs.map((pair) => pair.to)
  const repeatedSource = twice(sources)
  if (repeatedSource.length > 0) throw refuse(verb, `${repeatedSource[0]} is moved by more than one pair`)
  const repeatedDestination = twice(destinations)
  if (repeatedDestination.length > 0) {
    throw refuse(verb, `${repeatedDestination[0]} is the destination of more than one pair`)
  }

  const chained = pairs.find((pair) => pair.from !== pair.to && sources.includes(pair.to))
  if (chained) {
    throw refuse(
      verb,
      `${chained.to} is both a destination and a source in this plan. A chain or a swap cannot be re-run ` +
        `safely: after a partial run nothing on disk says which note is at ${chained.to}. Split it into two ` +
        'plans. Nothing was written',
    )
  }
}

/** Does a written link target name this slug by the resolver's suffix rule? */
function matchesSlug(slug, target) {
  const written = slugifyPath(target)
  return slug === written || slug.endsWith(`/${written}`)
}

/**
 * Remove the folders this plan's moves emptied, and name the ones that hold no
 * note any more but still hold something else.
 *
 * Only a folder a move left from is considered, and its ancestors, and never one
 * a destination lands in. A dry run answers from the listing, subtracting what the
 * plan would take away. `.DS_Store` is the file system's, not content: a folder
 * holding nothing else is empty.
 */
function settleFolders(notesDir, {moves, applied, dryRun}) {
  const vacated = [...moves.keys()].filter((from) => dryRun || applied.deleted.includes(from))
  const gone = new Set(vacated)
  const kept = new Set([...moves.values()].flatMap(ancestors))
  const folders = [...new Set(vacated.flatMap(ancestors))]
    .filter((folder) => !kept.has(folder))
    .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1))

  const removed = new Set()
  const notes = []
  for (const folder of folders) {
    const absolute = join(notesDir, folder)
    if (!existsSync(absolute)) continue
    const remaining = readdirSync(absolute).filter((name) => {
      const path = `${folder}/${name}`
      return !gone.has(path) && !removed.has(path)
    })
    const content = remaining.filter((name) => name !== '.DS_Store')

    if (content.length === 0) {
      if (!dryRun) {
        for (const name of remaining) rmSync(join(absolute, name))
        rmdirSync(absolute)
      }
      removed.add(folder)
      notes.push(`${dryRun ? 'would remove' : 'removed'} the empty folder ${folder}/`)
      continue
    }

    const holdsNotes = content.some((name) => name.endsWith('.md') || statSync(join(absolute, name)).isDirectory())
    if (!holdsNotes) {
      notes.push(`${folder}/ holds no note any more but was left, for what else it holds: ${content.sort().join(', ')}`)
    }
  }
  return notes
}

/** Every folder above a notes-relative path, nearest first. */
function ancestors(path) {
  const segments = path.split('/').slice(0, -1)
  return segments.map((_, at) => segments.slice(0, segments.length - at).join('/'))
}
