/**
 * `measure`: how big a note is, how dated it is, and how often something appears
 * in it — per note, in one call.
 *
 * It exists because it was rebuilt with `wc -l` and `grep -c` loops every time a
 * cleanup had to decide what was worth reading, and those loops get two things
 * wrong every time. **Front matter counts as prose** — a note with eight
 * front-matter fields and two sentences measures as a substantial note — and
 * **`grep -c` counts lines, not hits**, so three dates on one line are one. Both
 * are silent, and both make the number plausible.
 *
 * The body is what the parser says the body is: front matter is a node, so it is
 * dropped by position rather than by a regex over the first few lines, and a `---`
 * that was never front matter stays where it is.
 */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {createParser} from '@agent-wiki-toolbox/syntax'

const parser = createParser()

/** ISO dates, the form this estate writes them in and the only one counted. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g

/**
 * Measure notes.
 *
 * @param workspace  a loaded workspace
 * @param paths      workspace-relative notes, or folders, which expand to the notes under them.
 *                   Empty measures the whole wiki.
 * @param pattern    a regex, as a bare pattern or as `/pattern/flags`. Hits are counted, not lines.
 *
 * One row per note, plus the totals, so a caller asking "which of these is worth
 * reading" gets the comparison rather than a number per call.
 */
export function measure(workspace, {paths, pattern} = {}) {
  let matcher = null
  if (pattern) {
    try {
      matcher = buildMatcher(pattern)
    } catch (error) {
      return {ok: false, pattern, code: 'MEASURE_BAD_PATTERN', message: `${pattern} is not a regex: ${error.message}`}
    }
  }

  const {notes, missing} = expand(workspace, paths)
  const rows = notes.map((path) => measureOne(workspace, path, matcher))

  return {
    ok: missing.length === 0,
    pattern: pattern ?? null,
    // A path that named nothing is reported rather than dropped: a measure over
    // four notes that silently measured three answers the question it was not
    // asked, and the totals below would agree with it.
    missing,
    notes: rows,
    totals: {
      notes: rows.length,
      words: rows.reduce((sum, row) => sum + row.words, 0),
      dates: rows.reduce((sum, row) => sum + row.dates, 0),
      ...(matcher ? {matches: rows.reduce((sum, row) => sum + row.matches, 0)} : {}),
    },
  }
}

function measureOne(workspace, path, matcher) {
  const source = readFileSync(join(workspace.notesDir, path), 'utf8')
  const body = bodyOf(source)
  const row = {
    path,
    title: workspace.get(path)?.title ?? path,
    // `wc -w`'s word: a run of non-space. Markers count, which is what makes the
    // number comparable with the loop this replaces rather than better than it.
    words: (body.match(/\S+/g) ?? []).length,
    lines: body ? body.split('\n').length : 0,
    dates: count(body, ISO_DATE),
  }
  if (matcher) row.matches = count(body, matcher)
  return row
}

/**
 * The source with its front matter removed, by position rather than by pattern.
 *
 * A note whose body opens with a thematic break, or holds a `---` fence of its
 * own, is why: read off a regex, either one ends the block early and the count is
 * of half a note.
 */
export function bodyOf(source) {
  const tree = parser.parse(source)
  const first = tree.children[0]
  if (!first || (first.type !== 'yaml' && first.type !== 'toml')) return source
  const end = first.position?.end.offset
  return end === undefined ? source : source.slice(end)
}

function count(text, regex) {
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`)
  return (text.match(global) ?? []).length
}

/** `/pattern/flags` or a bare pattern. `search`'s convention, minus its literal-text half — this one is a regex either way. */
function buildMatcher(pattern) {
  const delimited = /^\/(.*)\/([gimsuy]*)$/s.exec(pattern)
  return delimited ? new RegExp(delimited[1], delimited[2]) : new RegExp(pattern)
}

/**
 * The notes named, with folders expanded off the index rather than off the disk.
 *
 * The index already walked the tree, so a folder costs a prefix comparison. A path
 * that is neither a note nor a folder is a miss, and travels back as one.
 */
function expand(workspace, paths) {
  if (!paths || paths.length === 0) return {notes: workspace.resources.map((resource) => resource.path), missing: []}

  const notes = []
  const missing = []
  const seen = new Set()
  for (const raw of paths) {
    const path = String(raw).replace(/\/+$/, '')
    const found = workspace.get(path)
      ? [path]
      : workspace.resources.map((resource) => resource.path).filter((one) => one.startsWith(`${path}/`))
    if (found.length === 0) {
      missing.push(path)
      continue
    }
    for (const one of found) {
      if (seen.has(one)) continue
      seen.add(one)
      notes.push(one)
    }
  }
  return {notes, missing}
}
