/**
 * `query`: a segment path, read rather than written.
 *
 * The resolver in `segments.js` says *which node*; this says what a caller gets
 * back when the answer is data rather than an edit. It is the read half of the
 * body domain and it sits in `core` beside `search` and `connections`, because a
 * query writes nothing — the write half of the same addressing scheme lives a
 * layer up, in `verbs`, and both resolve through the one resolver rather than
 * through two readings of a path.
 *
 * **Read mode, so a shorter path answers more.** `[{section: 'Fields'}]` is the
 * whole section; appending `{table: {}}` is every table in it and `{row: {}}`
 * every row of those. A write would refuse the fan-out; a read is where it is the
 * point. No path at all is the note's outline, which is the one answer a caller
 * needs before it can write a path for anything else — so the outline carries the
 * path that reaches each heading, and a caller reads its next call off this one.
 *
 * **Nothing mdast leaves here.** `renderTarget` hands back the nodes for a section
 * so a verb can splice them; a query is answered over a transport that serialises
 * to JSON, and a position-carrying mdast node is both enormous and useless to the
 * caller. What survives is the markdown, the text, and the lines it sat on.
 */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {createParser} from '@agent-wiki-toolbox/syntax'

import {renderTarget, resolvePath, sectionsOf} from './segments.js'

const parser = createParser()

/** The note is not there. Coded like the path failures, because a caller matches on it the same way. */
export const QUERY_CODES = {
  NOTE_NOT_FOUND: 'QUERY_NOTE_NOT_FOUND',
}

/**
 * Read a note's body through a segment path.
 *
 * @param workspace  a loaded workspace; the note is named the way every other read names one
 * @param note       workspace-relative path, e.g. `design/foo.md`
 * @param path       the segment path — `[{section: 'Fields'}, {table: {}}]`. Empty or absent is the outline.
 * @param outline    ask for the outline explicitly, whatever else was passed
 *
 * On success: `{ok: true, note, kind, targets, disagreements, …}`, where each
 * target is `renderTarget`'s data plus the lines it occupies. On a failure the
 * resolver's coded report travels unchanged, so `code`, `segment`, `resolved`,
 * `message` and `candidates` mean here exactly what they mean there.
 */
export function query(workspace, {note, path, outline = false} = {}) {
  const resource = workspace.get(note)
  if (!resource) {
    return {
      ok: false,
      note,
      code: QUERY_CODES.NOTE_NOT_FOUND,
      message:
        `no note at ${note}; query takes a workspace-relative path such as meta/conventions.md, ` +
        'and the segment path addresses inside it',
    }
  }

  const tree = parser.parse(readFileSync(join(workspace.notesDir, note), 'utf8'))

  if (outline || !Array.isArray(path) || path.length === 0) {
    return {ok: true, note, kind: 'outline', title: resource.title, outline: outlineOf(tree), disagreements: []}
  }

  const result = resolvePath(tree, path, {mode: 'read'})
  if (!result.ok) return {ok: false, note, ...result}

  return {
    ok: true,
    note,
    kind: result.targets[0].kind,
    segments: result.segments,
    resolved: result.resolved,
    // A path that fanned out says so rather than making the caller count: a read
    // that was meant to name one thing and reached nine is a caller's mistake the
    // resolver has no way to see, and the count is where it becomes visible.
    count: result.targets.length,
    targets: result.targets.map(asData),
    disagreements: result.disagreements,
  }
}

/**
 * Every heading, with the path that reaches it.
 *
 * `nth` is the ordinal among its own siblings, which is the number a segment
 * takes — not the ordinal in the document, which is what a flat list of headings
 * would invite a caller to pass and which addresses a different node.
 */
export function outlineOf(tree) {
  const found = []
  const walk = (parent, start, end, prefix) => {
    for (const section of sectionsOf(parent, start, end)) {
      const path = [...prefix, {section: {text: section.text, nth: section.nth}}]
      found.push({
        text: section.text,
        depth: section.depth,
        nth: section.nth,
        line: section.node.position?.start.line ?? null,
        path,
      })
      walk(parent, section.start + 1, section.end, path)
    }
  }
  walk(tree, 0, tree.children.length, [])
  return found
}

/**
 * One target as JSON: what it holds, and where it sat.
 *
 * The lines are not decoration. A caller that read a section here and edits it
 * with its own file tools needs to know which lines it is about to overwrite, and
 * a caller that reports a row of a table wants to say where the row is.
 */
function asData(target) {
  const {nodes, ...rendered} = renderTarget(target)
  return {...rendered, ...linesOf(target)}
}

function linesOf(target) {
  switch (target.kind) {
    case 'section': {
      const first = target.parent.children[target.start]
      const last = target.parent.children[target.end - 1]
      return span(first, last)
    }
    case 'column':
      // A column is not a node: it is an index sliced out of every row, so the
      // lines it covers are the table's.
      return span(target.table.node, target.table.node)
    case 'cell':
      return span(target.node, target.node)
    default:
      return span(target.node, target.node)
  }
}

function span(first, last) {
  const start = first?.position?.start.line ?? null
  const end = last?.position?.end.line ?? null
  return {line: start, endLine: end}
}
