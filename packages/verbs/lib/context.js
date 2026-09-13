/**
 * The scaffolding every verb shares: the index, the serializer, the write batch and
 * the shape of a report.
 *
 * The report is one shape for every verb, so a caller can ask what did not
 * happen without knowing which verb it called.
 */
import {existsSync} from 'node:fs'
import {dirname, isAbsolute, relative, resolve} from 'node:path'
import process from 'node:process'

import {loadWorkspace} from '@agent-wiki-toolbox/core'
import {buildProcessor} from '@agent-wiki-toolbox/format'

import {createEdit} from './edit.js'

const processor = buildProcessor()

export function createContext(notesDir, {workspace, dryRun = false} = {}) {
  return {
    workspace: workspace ?? loadWorkspace(notesDir),
    edit: createEdit(notesDir),
    processor,
    dryRun,
  }
}

/**
 * Does this path name a note the verbs' own way, relative to the notes directory?
 * A path that escapes the workspace when read that way names nothing here.
 */
export function namesANote(notesDir, path) {
  if (!path || isAbsolute(path)) return false
  const inside = relative(notesDir, resolve(notesDir, path))
  return Boolean(inside) && !inside.startsWith('..')
}

/**
 * The same path read the way the shell shows it, from the working directory, or
 * `null` when that lands outside the workspace.
 *
 * The verbs take notes-relative paths. A caller working from the repo root types
 * the path `git status` printed instead — `wiki/notes/design/x.md` — and a verb
 * that treats a miss as "nothing to do" then reports success for a note that is
 * sitting right there. Reading the path this second way is what turns that into
 * a hit. `fmt` already resolves against the cwd before the notes directory.
 */
export function fromWorkingDirectory(notesDir, path) {
  if (!path) return null
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path)
  const inside = relative(notesDir, absolute)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
  return inside
}

/**
 * The path this wiki knows the note by, given what the caller typed.
 *
 * Returns the path unchanged when the index already holds it, which is the
 * ordinary case, and the re-read form when that is what the caller meant. A verb
 * compares the two to say it re-read the path.
 *
 * **The index settles it whenever it can, and it cannot when no note is there.**
 * Every verb but one refuses a path with no note behind it, so which reading the
 * refusal names was only ever a matter of the message. `frontmatter`'s `schema`
 * asks about a path rather than about a note — it is the question an agent asks
 * *before* it writes — and there the reading is the whole answer: the globs are
 * matched against it, and a path read the wrong way matches nothing and comes
 * back as "no schema claims this", which is indistinguishable from the truth.
 *
 * So when neither reading is indexed, the directory decides. A path typed from
 * the repo root — `wiki/notes/projects/a/analysis/new.md` — read as
 * notes-relative would sit under a `wiki/notes/` inside the notes directory,
 * which is not there; read from the working directory it lands in a folder that
 * is. Where both exist or neither does, nothing has been learned and the typed
 * path stands.
 */
export function resolveNotePath(notesDir, index, path) {
  if (index.get(path)) return path
  const asTyped = fromWorkingDirectory(notesDir, path)
  if (!asTyped || asTyped === path) return path
  if (index.get(asTyped) || !namesANote(notesDir, path)) return asTyped
  return holdsThePath(notesDir, asTyped) && !holdsThePath(notesDir, path) ? asTyped : path
}

/** Is there a directory under the notes to hold a note at this notes-relative path? */
function holdsThePath(notesDir, path) {
  return existsSync(dirname(resolve(notesDir, path)))
}

/**
 * Parse a note out of the edit batch, so its bytes are the ones we will re-check —
 * and so a second edit to the same file in one verb builds on the first.
 */
export function parseNote(context, path) {
  return processor.parse(context.edit.current(path))
}

/** Serialize a tree the one way anything is ever written. */
export function serialize(tree) {
  return String(processor.stringify(tree))
}

/**
 * Finish a verb: apply the batch and return the report.
 *
 * `unresolved` lists the links the tool would not guess at. `settle` runs after the
 * batch is applied, with what was applied, and returns notes for the report. It travels beside
 * `skipped` so one return answers both "what did I not do" questions.
 */
export function finish(verb, context, {unresolved = [], notes = [], settle} = {}) {
  const applied = context.edit.commit({dryRun: context.dryRun})
  // What a verb tidies once the files have landed, reported in its notes.
  if (settle) notes = [...notes, ...settle(applied)]
  return {
    verb,
    ok: applied.skipped.length === 0 && unresolved.length === 0,
    dryRun: context.dryRun,
    ...applied,
    unresolved,
    notes,
  }
}

/** A verb that cannot start says so in the same shape, rather than throwing. */
export function refuse(verb, message, extra = {}) {
  const error = new Error(message)
  error.report = {
    verb,
    ok: false,
    changed: [],
    created: [],
    deleted: [],
    skipped: [],
    unresolved: [],
    notes: [message],
    ...extra,
  }
  return error
}
