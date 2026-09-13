/**
 * `move` — a section, block, table or list leaves one place and arrives at
 * another, in the same note or in a second one.
 *
 * Splice-out and insert are two halves of one thing: a gap between them destroys
 * content rather than leaving it stale, and a splice-out on its own is a delete.
 * So this is one operation whatever the destination, and a destination naming
 * another note is not a different kind of move — it is the same `destination`
 * argument doing what it was always going to do.
 *
 * **The insert is staged before the removal.** The write path applies staged
 * files in staging order and skips, per file, any that changed on disk since
 * they were read. Staging the destination first means a partial failure leaves
 * the moved range in both notes — visible, and recoverable from the report —
 * where the other order would delete it. That ordering rule is the whole safety
 * story; there is no commit protocol. Within one note there is one file and one
 * write, and the rule collapses to: resolve both addresses against the tree as
 * it was, then apply.
 *
 * **A re-run after a skipped source refuses the duplicate insert.** The
 * destination then already holds the moved range, serialised identically, at
 * exactly the position the move would put it. Inserting again would leave
 * three copies; finishing silently by removing the source would turn a
 * coincidence — a destination that happened to hold the same text there — into
 * a loss. So the refusal names the remedy: delete the source, which demands
 * the same nominal a move does.
 *
 * **Fixup at the destination, by node type.** A section's depth is set by
 * where it lands — one deeper than a section it is put inside, the same as one
 * it is put beside — and every heading in its range cascades with it, refused
 * rather than clamped past 6, through the same rebase an inserted payload gets.
 * A block, a table or a list carries no depth and moves as it is. A section
 * moves only to a section, since nothing else says what depth it should have.
 *
 * Out of scope, and not propagated: inbound `[[note#heading]]` links to a
 * section moved between notes. The verb reports them as `unresolved` through
 * the channel every other write already uses for an anchor it removed.
 */
import {describeTarget, resolvePath} from '@agent-wiki-toolbox/core'
import {visit} from '@agent-wiki-toolbox/syntax'

import {parseNote, resolveNotePath, serialize} from './context.js'

/** The coded failures `move` adds to the body verb's. */
export const MOVE_CODES = {
  /** No destination, a malformed one, a note it cannot find, or a target kind nothing moves to. */
  BAD_DESTINATION: 'BODY_BAD_DESTINATION',
  /** The destination sits inside the range being moved. */
  INTO_ITSELF: 'BODY_MOVE_INTO_ITSELF',
  /** The destination already holds this exact content at that position: a re-run after a skipped source. */
  ALREADY_AT_DESTINATION: 'BODY_MOVE_ALREADY_AT_DESTINATION',
}

/** What a destination of each kind can take. A kind absent here is not a place anything moves to. */
const DESTINATION_POSITIONS = {
  section: ['first', 'last', 'before', 'after'],
  block: ['before', 'after'],
  table: ['before', 'after'],
  list: ['before', 'after'],
}

/**
 * Build the `move` handler for the body verb's dispatch table. It takes the
 * verb's own `fail`, its `rebased` and its codes rather than importing them, so
 * the two modules do not import each other in a circle.
 */
export function createMove({fail, rebased, codes}) {
  return function move({context, tree, target: source, notePath, destination, notes}) {
    const {note, address, position} = readDestination(fail, destination)

    // Which note, and which tree. The same note is the same tree, still
    // unedited, so both addresses resolve against what the caller read.
    let destinationPath = notePath
    let destinationTree = tree
    if (note !== undefined) {
      destinationPath = resolveNotePath(context.edit.notesDir, context.workspace, note)
      if (destinationPath !== note) notes.push(`read destination ${note} as ${destinationPath}`)
      if (destinationPath !== notePath) {
        if (!context.edit.exists(destinationPath)) throw fail(MOVE_CODES.BAD_DESTINATION, `no note at ${destinationPath} to move into`)
        destinationTree = parseNote(context, destinationPath)
      }
    }
    const sameNote = destinationPath === notePath

    const resolution = resolvePath(destinationTree, address, {mode: 'write'})
    if (!resolution.ok) {
      const {ok, mode, message, code, ...detail} = resolution
      throw fail(code, `destination: ${message}`, {...detail, where: 'destination'})
    }
    const [at] = resolution.targets
    const disagreements = resolution.disagreements.map((disagreement) => ({...disagreement, where: 'destination'}))
    for (const disagreement of disagreements) {
      notes.push(
        `destination segment ${disagreement.segment}: the ${disagreement.type} named was at ${disagreement.field} ${disagreement.actual}, not ${disagreement.expected}; the name won`,
      )
    }

    const allowed = DESTINATION_POSITIONS[at.kind]
    if (!allowed) {
      throw fail(
        MOVE_CODES.BAD_DESTINATION,
        `nothing moves to a ${at.kind}; a destination is a section, a block, a table or a list`,
      )
    }
    if (source.kind === 'section' && at.kind !== 'section') {
      throw fail(
        MOVE_CODES.BAD_DESTINATION,
        `a section moves to a section — first or last inside it, before or after it — not to a ${at.kind}, since only a section says what depth it lands at`,
      )
    }
    if (!allowed.includes(position)) {
      throw fail(
        codes.BAD_POSITION,
        `a move to a ${at.kind} takes position ${allowed.join(', ')}${position === undefined ? '' : `, not "${position}"`}`,
      )
    }

    const range = rangeOf(source)
    const insertion = insertionPoint(at, position)
    const moving = range.parent.children.slice(range.start, range.end)

    if (sameNote && isInside(range, source, at, position)) {
      throw fail(MOVE_CODES.INTO_ITSELF, `the destination sits inside the ${source.kind} being moved; nothing was written`)
    }

    // What left, as markdown, before any fixup — the report's copy is what the
    // source held, so a mistake is put back as it was.
    const removed = markdownOf(moving)

    // The depth cascade, checked before anything moves so a refusal leaves both
    // trees as they were.
    let placed = moving
    if (source.kind === 'section') {
      const rebaseNotes = []
      placed = rebased(moving, insertion.depth, rebaseNotes)
      notes.push(...rebaseNotes.map((line) => line.replace("the payload's headings", "the moved section's headings")))
    }

    if (!sameNote) refuseDuplicate(fail, insertion, placed)

    if (sameNote) {
      // One tree: the removal has to come first for the indices to mean
      // anything, and the insertion point is shifted by what left ahead of it.
      splice(range.parent, range.start, range.end, [])
      let index = insertion.index
      if (insertion.parent === range.parent && index >= range.end) index -= moving.length
      splice(insertion.parent, index, index, placed)
    } else {
      // Two trees: the destination is staged here, first; the verb stages the
      // source after the handler returns. That order is the ordering rule.
      splice(insertion.parent, insertion.index, insertion.index, placed)
      context.edit.update(destinationPath, serialize(destinationTree))
      splice(range.parent, range.start, range.end, [])
    }

    return {
      removed,
      disagreements,
      moved: {
        from: {note: notePath, target: describeTarget(source)},
        to: {note: destinationPath, target: describeTarget(at), position},
        ...(source.kind === 'section' ? {depth: insertion.depth} : {}),
      },
    }
  }
}

/**
 * After the batch is applied: say what a skipped source means for a
 * between-notes move, since the report's `skipped` alone reads as "nothing
 * happened" and the opposite is true.
 */
export function afterMove(report, moved) {
  if (!moved || moved.from.note === moved.to.note) return
  const sourceSkipped = report.skipped.some((entry) => entry.path === moved.from.note)
  const destinationLanded = report.changed.includes(moved.to.note)
  if (sourceSkipped && destinationLanded) {
    report.notes.push(
      `${moved.from.note} changed on disk after the copy landed in ${moved.to.note}, so both notes hold it. ` +
        `Re-running refuses the duplicate insert (${MOVE_CODES.ALREADY_AT_DESTINATION}); finish by deleting the source at its address`,
    )
  }
}

// ---------------------------------------------------------------------------

function readDestination(fail, destination) {
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) {
    throw fail(MOVE_CODES.BAD_DESTINATION, 'move takes a destination: {note?, address, position}')
  }
  const {note, address, position, ...rest} = destination
  const unknown = Object.keys(rest)
  if (unknown.length > 0) {
    throw fail(MOVE_CODES.BAD_DESTINATION, `a destination does not take ${unknown.join(', ')}; it takes note, address, position`)
  }
  if (note !== undefined && (typeof note !== 'string' || !note)) {
    throw fail(MOVE_CODES.BAD_DESTINATION, 'destination.note is the path of the note to move into, or absent for this note')
  }
  return {note, address, position}
}

/** The slice of a parent's children a source occupies: a section's range, or one node. */
function rangeOf(source) {
  if (source.kind === 'section') return {parent: source.parent, start: source.start, end: source.end}
  return {parent: source.parent, start: source.index, end: source.index + 1}
}

/**
 * Where the moved nodes go, in pre-edit indices, and — for a section — the
 * depth its heading takes there: inside a section is one deeper, beside it is
 * the same. A block, table or list destination is a sibling slot in whatever
 * holds it.
 */
function insertionPoint(at, position) {
  if (at.kind === 'section') {
    const inside = position === 'first' || position === 'last'
    const index = {first: at.start + 1, last: at.end, before: at.start, after: at.end}[position]
    return {parent: at.parent, index, depth: inside ? at.depth + 1 : at.depth}
  }
  return {parent: at.parent, index: position === 'before' ? at.index : at.index + 1}
}

/**
 * Does the destination sit inside the range being moved? It does when its node
 * is one the range holds — the section itself, a subsection, a block or a list
 * item under it. The one exception is the source's own node with `before` or
 * `after`: that lands the range where it already is, a no-op, reported as one.
 */
function isInside(range, source, at, position) {
  const held = range.parent.children.slice(range.start, range.end).some((node) => node === at.node || descends(node, at.node))
  if (!held) return false
  return at.node !== source.node || position === 'first' || position === 'last'
}

function descends(node, wanted) {
  let found = false
  visit(node, (child) => {
    if (child === wanted) found = true
  })
  return found
}

/**
 * A prior run of this move whose source was skipped left the copy at the
 * destination. Re-resolving puts the insertion point either at the copy or
 * just after it, depending on whether the copy was absorbed into the
 * destination's own range, so both slots are compared.
 */
function refuseDuplicate(fail, insertion, placed) {
  const {parent, index} = insertion
  const wanted = markdownOf(placed)
  const count = placed.length
  for (const from of [index, index - count]) {
    if (from < 0) continue
    const there = parent.children.slice(from, from + count)
    if (there.length === count && markdownOf(there) === wanted) {
      throw fail(
        MOVE_CODES.ALREADY_AT_DESTINATION,
        'the destination already holds exactly this content at that position — a re-run after the source was skipped. ' +
          'Inserting again would duplicate it; delete the source at its address to finish the move',
      )
    }
  }
}

function splice(parent, start, end, nodes) {
  parent.children.splice(start, end - start, ...nodes)
}

function markdownOf(nodes) {
  return serialize({type: 'root', children: nodes})
}
