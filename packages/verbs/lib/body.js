/**
 * `body` — one verb over the markdown body, by segment path.
 *
 * The other half of the split `frontmatter` opened: the body is its own domain,
 * with its own parser, its own address — a path of segments rather than a key —
 * and its own hazards, which are all one hazard in different clothes: a string
 * edit that lands in the wrong place, or escapes a `[[link]]` on the way in, and
 * reports success. So nothing here is string-spliced. The payload is markdown,
 * parsed by the same processor that parsed the note, spliced in as nodes and
 * serialised through the same wikilink-aware printer every other verb uses.
 *
 * **Two axes, target and operation.** The target is a path (see `resolvePath` in
 * `core`, which owns the safety property — a name beats an ordinal, and a
 * disagreement between the two is reported rather than hidden). The operation is
 * one of five, and which apply is a property of the path's terminal segment:
 *
 *     section    replace, insert, delete, shift_level      (move: later)
 *     heading    replace
 *     block      replace, insert, delete                   (move: later)
 *     table      replace, delete                           (move: later)
 *     row        replace, insert, delete, move             (within its table)
 *     column     replace, insert, delete, move             (within its table)
 *     cell       replace
 *     list       replace, delete                           (move: later)
 *     list_item  replace, insert, delete
 *
 * The table and list rows live in `body-tables.js`, with their payload shapes.
 *
 * The table is keyed by terminal kind so the next increment adds a row rather
 * than a branch. The design's full terminal-for matrix is kept beside it, so a
 * pair the scheme allows but this build lacks is refused as *not built*, and a
 * pair the scheme rules out is refused as *not a thing* — a caller can tell the
 * two apart.
 *
 * **Delete requires the nominal half of its terminal segment.** A wrong replace
 * leaves content in the wrong place, which a reader notices; a wrong delete leaves
 * nothing, which nobody does. A caller that read the section has its heading
 * text, and one that read the block has its opening words, so asking for either
 * costs a caller nothing and is proof that it read what it is about to remove. The
 * report carries what was removed, as markdown, so a mistake is recoverable from
 * the report and not only from git.
 *
 * **`shift_level` refuses at the boundary rather than clamping.** Clamping
 * silently flattens a hierarchy — a parent and its child become siblings and
 * nothing reports it.
 *
 * **A renamed heading breaks every `[[note#heading]]` into it, invisibly**, which
 * is the reason `heading` is a segment at all. So `heading:replace` rewrites those
 * links, in this note and in every note that links here, and every other write
 * reports the inbound links whose anchor it removed as `unresolved` — the same
 * channel `splitByHeading` uses for the links it cannot repoint.
 *
 * Failures are coded rather than inferred. Resolver failures pass through with
 * their `PATH_*` codes and their localisation — which segment, how many resolved,
 * which candidates — and this verb's own are in `BODY_CODES`.
 */
import {createAnchorSlugger, describeTarget, resolvePath, textOf} from '@agent-wiki-toolbox/core'
import {visit} from '@agent-wiki-toolbox/syntax'

import {LIST_OPERATIONS, TABLE_OPERATIONS} from './body-tables.js'
import {createContext, finish, parseNote, refuse, resolveNotePath, serialize} from './context.js'
import {visitLinks} from './rewrite.js'

const VERB = 'body'

/** The coded failures. A caller matches on these, never on the sentence beside them. */
export const BODY_CODES = {
  /** The operation exists but not for this terminal segment, in the scheme or in this build. */
  UNSUPPORTED: 'BODY_UNSUPPORTED_OPERATION',
  /** A delete whose terminal segment carries no nominal half. */
  NOMINAL_REQUIRED: 'BODY_NOMINAL_REQUIRED',
  /** A payload that parses to nothing. */
  EMPTY_PAYLOAD: 'BODY_EMPTY_PAYLOAD',
  /** A section payload that does not open with a heading, or holds more than one section. */
  PAYLOAD_NOT_A_SECTION: 'BODY_PAYLOAD_NOT_A_SECTION',
  /** A heading payload that is not one line of inline markdown. */
  PAYLOAD_NOT_A_HEADING: 'BODY_PAYLOAD_NOT_A_HEADING',
  /** A block payload that carries a heading, which would restructure the section it lands in. */
  PAYLOAD_NOT_A_BLOCK: 'BODY_PAYLOAD_NOT_A_BLOCK',
  /** A `position` the target kind does not take. */
  BAD_POSITION: 'BODY_BAD_POSITION',
  /** A `delta` that is not a non-zero integer. */
  BAD_DELTA: 'BODY_BAD_DELTA',
  /** A heading that would leave depths 1–6, by `shift_level` or by a rebased payload. */
  DEPTH_OUT_OF_RANGE: 'BODY_DEPTH_OUT_OF_RANGE',
  /** A table payload that is not exactly one markdown table. */
  PAYLOAD_NOT_A_TABLE: 'BODY_PAYLOAD_NOT_A_TABLE',
  /** A row payload that is not one row line or an array of cells, or has more cells than the header. */
  PAYLOAD_NOT_A_ROW: 'BODY_PAYLOAD_NOT_A_ROW',
  /** A column payload that is not an array of strings one longer than the body rows. */
  PAYLOAD_NOT_A_COLUMN: 'BODY_PAYLOAD_NOT_A_COLUMN',
  /** A cell's text that does not read as one table cell: two paragraphs, a line break. */
  PAYLOAD_NOT_INLINE: 'BODY_PAYLOAD_NOT_INLINE',
  /** A list payload that is not exactly one markdown list. */
  PAYLOAD_NOT_A_LIST: 'BODY_PAYLOAD_NOT_A_LIST',
  /** A list item payload that holds a heading or several items. */
  PAYLOAD_NOT_A_LIST_ITEM: 'BODY_PAYLOAD_NOT_A_LIST_ITEM',
  /** A `move` destination of the wrong shape, or naming nothing. */
  BAD_DESTINATION: 'BODY_BAD_DESTINATION',
}

const OPERATION_NAMES = new Set(['replace', 'insert', 'delete', 'move', 'shift_level'])

/**
 * The design's terminal-for matrix, whole, so a refusal can say whether the
 * scheme rules a pair out or this build has not reached it yet.
 */
const TERMINAL_FOR = {
  section: ['replace', 'insert', 'delete', 'move', 'shift_level'],
  heading: ['replace'],
  table: ['replace', 'delete', 'move'],
  row: ['replace', 'insert', 'delete', 'move'],
  column: ['replace', 'insert', 'delete', 'move'],
  cell: ['replace'],
  list: ['replace', 'delete', 'move'],
  list_item: ['replace', 'insert', 'delete'],
  block: ['replace', 'insert', 'delete', 'move'],
}

/** Which field is the nominal half, per segment type — what `delete` demands. */
const NOMINAL_FIELD = {
  section: 'text',
  heading: 'text',
  table: 'header',
  row: 'where',
  column: 'header',
  list: 'prefix',
  list_item: 'term',
  block: 'prefix',
}

const MIN_DEPTH = 1
const MAX_DEPTH = 6

const fail = (code, message, extra = {}) => refuse(VERB, message, {code, ...extra})

/**
 * Write to one note's body.
 *
 * `path` is workspace-relative. `address` is a segment path; `operation` is one
 * of the five. `payload` is markdown text, for `replace` and `insert`;
 * `position` says where an `insert` lands — `first`/`last` inside a section,
 * `before`/`after` a section or a block; `delta` is `shift_level`'s signed
 * amount; `destination` is where a `move` lands.
 *
 * Returns the verb report every other verb returns, plus `target` — the node the
 * address resolved to, as data — `disagreements` from the resolver, and `removed`
 * on a delete: the markdown that is no longer there.
 */
export function body(notesDir, {path, address, operation, payload, position, delta, destination, workspace, dryRun} = {}) {
  if (!path) throw refuse(VERB, 'body needs a path')
  if (!OPERATION_NAMES.has(operation)) {
    throw refuse(VERB, `no such operation "${operation}"; it is one of ${[...OPERATION_NAMES].join(', ')}`)
  }

  const context = createContext(notesDir, {workspace, dryRun})
  const notePath = resolveNotePath(notesDir, context.workspace, path)
  const notes = []
  if (notePath !== path) notes.push(`read ${path} as ${notePath}`)
  if (!context.edit.exists(notePath)) throw refuse(VERB, `no note at ${notePath}`)

  const tree = parseNote(context, notePath)
  const resolution = resolvePath(tree, address, {mode: 'write'})
  if (!resolution.ok) {
    const {ok, mode, message, ...detail} = resolution
    throw refuse(VERB, message, detail)
  }
  const [target] = resolution.targets
  const {disagreements} = resolution
  for (const disagreement of disagreements) {
    notes.push(
      `segment ${disagreement.segment}: the ${disagreement.type} named was at ${disagreement.field} ${disagreement.actual}, not ${disagreement.expected}; the name won`,
    )
  }

  const handler = OPERATIONS[target.kind]?.[operation]
  if (!handler) {
    const scheme = TERMINAL_FOR[target.kind] ?? []
    throw fail(
      BODY_CODES.UNSUPPORTED,
      scheme.includes(operation)
        ? `${operation} on a ${target.kind} is not built yet; a ${target.kind} is terminal for ${scheme.join(', ')}`
        : `${operation} does not apply to a ${target.kind}, which is terminal for ${scheme.join(', ') || 'nothing'}`,
    )
  }

  if (operation === 'delete') {
    const field = NOMINAL_FIELD[target.kind]
    const last = address[address.length - 1][target.kind]
    const named = typeof last === 'string' || (last && last[field] !== undefined)
    if (!named) {
      throw fail(
        BODY_CODES.NOMINAL_REQUIRED,
        `delete needs the ${target.kind}'s ${field}: a caller that read what it is removing can say what it is, ` +
          'and a delete at an ordinal alone leaves nothing behind to show it went wrong',
      )
    }
  }

  const before = serialize(tree)
  const anchorsBefore = anchorsOf(tree)
  const outcome = handler({context, tree, target, payload, position, delta, destination, notes}) ?? {}
  const after = serialize(tree)

  if (after === before) {
    notes.push('the body already says that; nothing written')
    return {...finish(VERB, context, {notes}), target: describeTarget(target), disagreements}
  }

  // The anchors this write took away, and the links that were using them. A
  // rename repoints them; anything else reports them, since there is nothing to
  // repoint to.
  const anchorsAfter = anchorsOf(tree)
  const unresolved = []
  if (outcome.renamed) {
    repointAnchors(context, notePath, tree, outcome.renamed, notes)
    // A heading that now repeats one already in the note takes its anchor if it
    // sits first, and every later duplicate's `-1` moves along by one. Nothing
    // here can say which the old links meant, so it is said out loud.
    if (anchorsBefore.has(outcome.renamed.to)) {
      notes.push(`#${outcome.renamed.to} was already an anchor in this note; links to it, and to its numbered duplicates, may now land on a different heading`)
    }
  } else {
    const gone = [...anchorsBefore].filter((anchor) => !anchorsAfter.has(anchor))
    if (gone.length > 0) unresolved.push(...danglingInbound(context, notePath, tree, gone, operation))
  }

  context.edit.update(notePath, serialize(tree))
  const report = finish(VERB, context, {unresolved, notes})
  return {
    ...report,
    target: describeTarget(target),
    disagreements,
    ...(outcome.removed !== undefined ? {removed: outcome.removed} : {}),
  }
}

// ---------------------------------------------------------------------------
// The operations, keyed by terminal kind

/**
 * Each handler mutates `tree` and returns `{removed?, renamed?}`: the markdown
 * a delete took out, or the `{from, to}` anchor a rename moved. Adding a terminal
 * is adding a key here; adding an operation is adding a row to a key.
 */
const OPERATIONS = {
  section: {
    replace({context, tree, target, payload, notes}) {
      const nodes = sectionPayload(context, payload, target.depth, notes)
      splice(target.parent, target.start, target.end, nodes)
    },

    insert({context, tree, target, payload, position, notes}) {
      const where = positionOf(position, ['first', 'last', 'before', 'after'], 'section')
      const inside = where === 'first' || where === 'last'
      // Content inside a section is that section's; a heading in it is a
      // subsection, one deeper. Beside the section it is a sibling.
      const nodes = rebased(bodyPayload(context, payload), inside ? target.depth + 1 : target.depth, notes)
      const at = {first: target.start + 1, last: target.end, before: target.start, after: target.end}[where]
      splice(target.parent, at, at, nodes)
    },

    delete({target}) {
      const removed = target.parent.children.slice(target.start, target.end)
      splice(target.parent, target.start, target.end, [])
      return {removed: markdownOf(removed)}
    },

    shift_level({target, delta}) {
      if (!Number.isInteger(delta) || delta === 0) {
        throw fail(BODY_CODES.BAD_DELTA, 'shift_level takes a non-zero integer delta')
      }
      const headings = target.parent.children.slice(target.start, target.end).filter((node) => node.type === 'heading')
      // Checked before anything moves, so a refusal leaves the tree as it was.
      for (const heading of headings) {
        const depth = heading.depth + delta
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) {
          throw fail(
            BODY_CODES.DEPTH_OUT_OF_RANGE,
            `shifting by ${delta} would take "${textOf(heading)}" from depth ${heading.depth} to ${depth}; headings run ${MIN_DEPTH}–${MAX_DEPTH}, and clamping would flatten the hierarchy`,
            {heading: textOf(heading), depth: heading.depth, wanted: depth},
          )
        }
      }
      for (const heading of headings) heading.depth += delta
    },
  },

  heading: {
    replace({context, tree, target, payload, notes}) {
      const children = headingPayload(context, payload, notes)
      const from = anchorAt(tree, target.node)
      target.node.children = children
      const to = anchorAt(tree, target.node)
      return from === to ? {} : {renamed: {from, to}}
    },
  },

  block: {
    replace({context, target, payload}) {
      const nodes = blockPayload(context, payload)
      splice(target.parent, target.index, target.index + 1, nodes)
    },

    insert({context, target, payload, position}) {
      const where = positionOf(position, ['before', 'after'], 'block')
      const nodes = blockPayload(context, payload)
      const at = where === 'before' ? target.index : target.index + 1
      splice(target.parent, at, at, nodes)
    },

    delete({target}) {
      const removed = [target.node]
      splice(target.parent, target.index, target.index + 1, [])
      return {removed: markdownOf(removed)}
    },
  },

  ...TABLE_OPERATIONS,
  ...LIST_OPERATIONS,
}

function splice(parent, start, end, nodes) {
  parent.children.splice(start, end - start, ...nodes)
}

function positionOf(position, allowed, kind) {
  if (!allowed.includes(position)) {
    throw fail(
      BODY_CODES.BAD_POSITION,
      `insert at a ${kind} takes position ${allowed.join(', ')}${position === undefined ? '' : `, not "${position}"`}`,
    )
  }
  return position
}

// ---------------------------------------------------------------------------
// Payloads: markdown in, nodes out

/**
 * The payload as top-level nodes, parsed by the note's own processor. A front
 * matter block in a payload is not body content and is dropped with a note, so
 * a payload pasted from a whole note does not land a `---` fence mid-document.
 */
function bodyPayload(context, payload) {
  if (typeof payload !== 'string') throw fail(BODY_CODES.EMPTY_PAYLOAD, 'this operation takes a markdown payload')
  const nodes = context.processor.parse(payload).children.filter((node) => node.type !== 'yaml')
  if (nodes.length === 0) throw fail(BODY_CODES.EMPTY_PAYLOAD, 'the payload holds no markdown')
  return nodes
}

/**
 * A section payload opens with a heading and holds one section: nothing in it is
 * as shallow as that heading. A payload with no heading would decapitate the
 * section — that is `delete`'s job, not a replace's side effect — and one with
 * two top-level sections would land a sibling under a section's address.
 *
 * The depth is the address's, not the payload's: the target sits where it sits in
 * the hierarchy, and a payload written at another depth is rebased to it and the
 * rebase is reported.
 */
function sectionPayload(context, payload, depth, notes) {
  const nodes = bodyPayload(context, payload)
  const [first] = nodes
  if (first.type !== 'heading') {
    throw fail(
      BODY_CODES.PAYLOAD_NOT_A_SECTION,
      'replacing a section takes a payload that opens with its heading; to remove the heading, delete the section, and to keep it as it is, restate it',
    )
  }
  const shallower = nodes.slice(1).find((node) => node.type === 'heading' && node.depth <= first.depth)
  if (shallower) {
    throw fail(
      BODY_CODES.PAYLOAD_NOT_A_SECTION,
      `the payload holds more than one section: "${textOf(shallower)}" is not under "${textOf(first)}"`,
    )
  }
  return rebased(nodes, depth, notes)
}

/** Block payloads are prose: a heading in one would open a section where a paragraph was asked for. */
function blockPayload(context, payload) {
  const nodes = bodyPayload(context, payload)
  const heading = nodes.find((node) => node.type === 'heading')
  if (heading) {
    throw fail(
      BODY_CODES.PAYLOAD_NOT_A_BLOCK,
      `a block payload holds prose, and this one holds a heading, "${textOf(heading)}"; a heading is inserted at a section`,
    )
  }
  return nodes
}

/**
 * The new heading text: one line of inline markdown, so a `[[link]]` or a code
 * span in it survives. A heading line is accepted too, its marks ignored, since
 * the depth is the node's to keep.
 */
function headingPayload(context, payload, notes) {
  if (typeof payload !== 'string' || !payload.trim()) {
    throw fail(BODY_CODES.PAYLOAD_NOT_A_HEADING, 'renaming a heading takes the new heading text')
  }
  const nodes = context.processor.parse(payload).children
  const [only] = nodes
  if (nodes.length !== 1 || (only.type !== 'paragraph' && only.type !== 'heading')) {
    throw fail(BODY_CODES.PAYLOAD_NOT_A_HEADING, 'renaming a heading takes one line of heading text, nothing more')
  }
  if (only.type === 'heading') notes.push('the payload was written as a heading; its depth was ignored, since the depth is the target\'s')
  return only.children
}

/**
 * Shift a payload's headings so its shallowest sits at `depth`. Nodes with no
 * heading pass through. A shift that would push any heading past 6 is refused,
 * the same refusal `shift_level` makes.
 */
function rebased(nodes, depth, notes) {
  const headings = nodes.filter((node) => node.type === 'heading')
  if (headings.length === 0) return nodes
  const shallowest = Math.min(...headings.map((node) => node.depth))
  const delta = depth - shallowest
  if (delta === 0) return nodes
  for (const heading of headings) {
    const wanted = heading.depth + delta
    if (wanted > MAX_DEPTH) {
      throw fail(
        BODY_CODES.DEPTH_OUT_OF_RANGE,
        `the payload sits at depth ${depth} here, which would take "${textOf(heading)}" to ${wanted}; headings run ${MIN_DEPTH}–${MAX_DEPTH}`,
        {heading: textOf(heading), depth: heading.depth, wanted},
      )
    }
  }
  for (const heading of headings) heading.depth += delta
  notes.push(`the payload's headings were ${delta > 0 ? 'deepened' : 'raised'} by ${Math.abs(delta)} to sit at depth ${depth}`)
  return nodes
}

/** Markdown for a run of nodes, through the one printer everything is written with. */
function markdownOf(nodes) {
  return serialize({type: 'root', children: nodes})
}

// ---------------------------------------------------------------------------
// Anchors: what a rename breaks, and what a delete leaves dangling

/**
 * Every heading's anchor, numbered the way the index numbers them — a primed
 * slugger over the headings in document order, wherever they sit — so a repeated
 * heading's `-1` here is the `-1` a link into it carries.
 */
function anchorsOf(tree) {
  const anchorOf = createAnchorSlugger()
  const anchors = new Set()
  visit(tree, 'heading', (node) => {
    anchors.add(anchorOf(textOf(node)))
  })
  return anchors
}

/** The anchor one heading node gets, in the numbering of the tree it sits in. */
function anchorAt(tree, heading) {
  const anchorOf = createAnchorSlugger()
  let found = null
  visit(tree, 'heading', (node) => {
    const anchor = anchorOf(textOf(node))
    if (node === heading) found = anchor
  })
  return found
}

/** Does this link, from `from`, point at `notePath`? A bare `[[#anchor]]` points at its own note. */
function pointsAt(index, node, from, notePath) {
  if (node.type !== 'wikiLink' || !node.anchor) return false
  if (!node.target) return from === notePath
  const outcome = index.resolve(node.target)
  return outcome.status === 'resolved' && outcome.resource.path === notePath
}

/**
 * A rename: every `[[note#old]]` becomes `[[note#new]]`, in this note's own tree
 * — already parsed and about to be written — and in every note that links here.
 */
function repointAnchors(context, notePath, tree, {from, to}, notes) {
  const index = context.workspace
  let count = 0
  const repoint = (linkTree, linkingPath) => {
    let touched = false
    visitLinks(linkTree, (node) => {
      if (!pointsAt(index, node, linkingPath, notePath) || node.anchor !== from) return
      node.anchor = to
      touched = true
      count++
    })
    return touched
  }
  repoint(tree, notePath)
  for (const linkingPath of index.backlinks(notePath)) {
    if (linkingPath === notePath) continue
    const linkTree = parseNote(context, linkingPath)
    if (repoint(linkTree, linkingPath)) context.edit.update(linkingPath, serialize(linkTree))
  }
  if (count > 0) notes.push(`repointed ${count} link${count === 1 ? '' : 's'} from #${from} to #${to}`)
}

/** The inbound links whose anchor this write removed. Nothing to repoint them to, so they are reported. */
function danglingInbound(context, notePath, tree, gone, operation) {
  const index = context.workspace
  const unresolved = []
  const collect = (linkTree, linkingPath) => {
    visitLinks(linkTree, (node) => {
      if (!pointsAt(index, node, linkingPath, notePath) || !gone.includes(node.anchor)) return
      unresolved.push({
        from: linkingPath,
        line: node.position?.start.line ?? 0,
        target: node.target ? `${node.target}#${node.anchor}` : `#${node.anchor}`,
        reason: `the ${operation} removed the heading #${node.anchor} this link points at`,
      })
    })
  }
  for (const linkingPath of index.backlinks(notePath)) {
    if (linkingPath === notePath) continue
    collect(parseNote(context, linkingPath), linkingPath)
  }
  // The note's own `[[#anchor]]` links, in the tree as it now stands: a deleted
  // section's links into itself went with it and are not dangling.
  collect(tree, notePath)
  return unresolved
}
