/**
 * `buildListing`: regenerate the notes table in the root `index.md`. One table per
 * area, one row per note. Only the region between the markers is touched;
 * everything else in the file is left exactly as it is.
 *
 * **An area is what a note's `area:` says, and nothing else.** Which areas a wiki
 * has, what they are called and what order they read in are the project's choices.
 * The listing used to supply both halves itself — the top folder for a note with
 * no `area`, and a built-in order of `analysis, design, …` — which filed every
 * note of a nested layout under `projects` and ranked a vocabulary the toolbox
 * does not own. Now:
 *
 * - a note with no `area` is listed under `(no area)`, last, and named in the
 *   report; a wiki where no note has one gets a single table with no heading;
 * - the order is the one the caller passes, else the one the listing's own
 *   headings already have, with areas it does not mention yet after them, sorted.
 *   The file is where a project wrote its order down, and reading it keeps a
 *   listing stable without a setting.
 */
import {createContext, finish, refuse, resolveNotePath} from './context.js'
import {shortestResolvingForm} from './rewrite.js'

export const MARKER_START = '<!-- awt:listing:start -->'
export const MARKER_END = '<!-- awt:listing:end -->'

/** OKF reserves these two names at the bundle root for the listing and the chronology. */
const RESERVED = new Set(['index.md', 'log.md'])

/** The group for notes with no `area`, in parentheses so it cannot be an area's name. */
const NO_AREA = '(no area)'

/**
 * @param path     the listing file, default `index.md`.
 * @param areas    the order areas appear in; default the order the listing's
 *                 headings already have. Anything else follows, sorted.
 * @param columns  `['note', 'about']` by default; `topic` and `area` are opt-in.
 */
export function buildListing(notesDir, {path: typedPath = 'index.md', areas, columns, workspace, dryRun} = {}) {
  const verb = 'buildListing'
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  // The path as this wiki names it, so `--path wiki/notes/index.md` typed from the
  // repo root finds the listing file, as every other verb that takes a path does.
  const path = resolveNotePath(notesDir, index, typedPath)
  if (path !== typedPath) notes.push(`read ${typedPath} as ${path}, relative to the notes directory`)

  if (!context.edit.exists(path)) throw refuse(verb, `no listing file at ${path}`)

  const source = context.edit.load(path).source
  const start = source.indexOf(MARKER_START)
  const end = source.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) {
    throw refuse(
      verb,
      `${path} has no managed block. Add ${MARKER_START} and ${MARKER_END} where the listing belongs.`,
    )
  }

  const wanted = columns ?? ['note', 'about']
  const order = areas ?? headingsIn(source.slice(start + MARKER_START.length, end))
  // The listing file itself and the OKF reserved names at the bundle root are not
  // notes, so they get no row.
  const withoutSelf = index.resources.filter((resource) => resource.path !== path && !RESERVED.has(resource.path))

  const byArea = new Map()
  const missing = []
  const unassigned = []
  for (const resource of withoutSelf) {
    const area = areaOf(resource) ?? NO_AREA
    if (area === NO_AREA) unassigned.push(resource.path)
    if (!byArea.has(area)) byArea.set(area, [])
    byArea.get(area).push(resource)
    if (!resource.properties.description) missing.push(resource.path)
  }

  const known = order.filter((area) => area !== NO_AREA && byArea.has(area))
  const extra = [...byArea.keys()].filter((area) => area !== NO_AREA && !order.includes(area)).sort()
  const groups = [...known, ...extra, ...(byArea.has(NO_AREA) ? [NO_AREA] : [])]

  // A row links to a note by the shortest form that resolves: a bare stem where
  // the basename is unique, a folder segment where it is not.
  const unnameable = []
  const linkTo = (resource) => {
    const form = shortestResolvingForm(resource, index.resolve)
    if (form === null) {
      unnameable.push(resource.path)
      return escapePipes(resource.path)
    }
    return `[[${form}]]`
  }

  const blocks = []
  if (groups.length === 1 && groups[0] === NO_AREA) {
    // Nothing in this wiki has an area, so there is nothing to group by.
    blocks.push(...table(byArea.get(NO_AREA), wanted, linkTo), '')
  } else {
    for (const area of groups) {
      blocks.push(`### ${area}`, '')
      blocks.push(...table(byArea.get(area), wanted, linkTo))
      blocks.push('')
    }
    if (unassigned.length > 0) {
      notes.push(
        `${unassigned.length} note(s) have no front-matter area, so they are listed under ${NO_AREA}: ` +
          unassigned.join(', '),
      )
    }
  }

  const body = `${MARKER_START}\n\n${blocks.join('\n').trimEnd()}\n\n${MARKER_END}`
  // Straight through the serializer like everything else, so the table comes out in
  // the estate's own table style rather than in this file's idea of one — and so
  // the comparison below is against what would actually be written.
  const next = formatDocument(context, source.slice(0, start) + body + source.slice(end + MARKER_END.length))

  if (unnameable.length > 0) {
    notes.push(
      `${unnameable.length} note(s) have no link form that resolves to them, so their row names the path ` +
        `instead: ${unnameable.join(', ')}`,
    )
  }
  if (missing.length > 0) {
    notes.push(
      `${missing.length} note(s) have no front-matter description, so their row is blank: ${missing.join(', ')}`,
    )
  }

  if (next === source) {
    notes.push('the listing was already current')
    return finish(verb, context, {notes})
  }

  context.edit.update(path, next)
  return finish(verb, context, {notes})
}

function formatDocument(context, source) {
  return String(context.processor.stringify(context.processor.parse(source)))
}

/** The `area` front-matter field, or null. Never the folder: see the top of this file. */
function areaOf(resource) {
  const area = resource.properties.area
  return area === undefined || area === null || area === '' ? null : String(area)
}

/** The `###` headings of the current listing, in order: the order the project keeps. */
function headingsIn(block) {
  return [...block.matchAll(/^### (.+?)\s*$/gm)].map((match) => match[1])
}

const HEADERS = {note: 'Note', topic: 'Topic', area: 'Area', about: 'About'}

function table(resources, columns, linkTo) {
  const cell = (resource, column) => {
    if (column === 'note') return linkTo(resource)
    if (column === 'topic') return escapePipes(String(resource.properties.topic ?? ''))
    if (column === 'area') return escapePipes(areaOf(resource) ?? '')
    return escapePipes(String(resource.properties.description ?? ''))
  }

  const rows = [...resources].sort((a, b) => (a.path < b.path ? -1 : 1))
  return [
    `| ${columns.map((column) => HEADERS[column] ?? column).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((resource) => `| ${columns.map((column) => cell(resource, column)).join(' | ')} |`),
  ]
}

/** A cell containing a pipe would otherwise end early. */
function escapePipes(text) {
  return text.replace(/\|/g, '\\|')
}
