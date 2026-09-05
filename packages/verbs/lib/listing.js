/**
 * `buildListing`: regenerate the notes table in the root `index.md`. One table per
 * area, one row per note. Only the region between the markers is touched;
 * everything else in the file is left exactly as it is.
 */
import {createContext, finish, refuse} from './context.js'
import {shortestResolvingForm} from './rewrite.js'

export const MARKER_START = '<!-- awt:listing:start -->'
export const MARKER_END = '<!-- awt:listing:end -->'

/** OKF reserves these two names at the bundle root for the listing and the chronology. */
const RESERVED = new Set(['index.md', 'log.md'])

/**
 * @param path     the listing file, default `index.md`.
 * @param areas    the order areas appear in; anything else follows, sorted.
 * @param columns  `['note', 'about']` by default; `topic` and `area` are opt-in.
 */
export function buildListing(notesDir, {path = 'index.md', areas, columns, workspace, dryRun} = {}) {
  const verb = 'buildListing'
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace

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
  const order = areas ?? ['analysis', 'design', 'implementation', 'worklog', 'meta']
  // The listing file itself and the OKF reserved names at the bundle root are not
  // notes, so they get no row.
  const withoutSelf = index.resources.filter((resource) => resource.path !== path && !RESERVED.has(resource.path))

  const byArea = new Map()
  const missing = []
  for (const resource of withoutSelf) {
    const area = areaOf(resource)
    if (!byArea.has(area)) byArea.set(area, [])
    byArea.get(area).push(resource)
    if (!resource.properties.description) missing.push(resource.path)
  }

  const known = order.filter((area) => byArea.has(area))
  const extra = [...byArea.keys()].filter((area) => !order.includes(area)).sort()

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
  for (const area of [...known, ...extra]) {
    blocks.push(`### ${area}`, '')
    blocks.push(...table(byArea.get(area), wanted, linkTo))
    blocks.push('')
  }

  const body = `${MARKER_START}\n\n${blocks.join('\n').trimEnd()}\n\n${MARKER_END}`
  // Straight through the serializer like everything else, so the table comes out in
  // the estate's own table style rather than in this file's idea of one — and so
  // the comparison below is against what would actually be written.
  const next = formatDocument(context, source.slice(0, start) + body + source.slice(end + MARKER_END.length))

  const notes = []
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

/** The `area` front-matter field, else the top-level folder. */
function areaOf(resource) {
  return resource.properties.area ?? resource.path.split('/')[0]
}

const HEADERS = {note: 'Note', topic: 'Topic', area: 'Area', about: 'About'}

function table(resources, columns, linkTo) {
  const cell = (resource, column) => {
    if (column === 'note') return linkTo(resource)
    if (column === 'topic') return escapePipes(String(resource.properties.topic ?? ''))
    if (column === 'area') return escapePipes(String(areaOf(resource)))
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
