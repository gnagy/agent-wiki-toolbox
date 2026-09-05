/**
 * The scaffolding every verb shares: the index, the serializer, the write batch and
 * the shape of a report.
 *
 * The report is one shape for every verb, so a caller can ask what did not
 * happen without knowing which verb it called.
 */
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
 * `unresolved` lists the links the tool would not guess at. It travels beside
 * `skipped` so one return answers both "what did I not do" questions.
 */
export function finish(verb, context, {unresolved = [], notes = []} = {}) {
  const applied = context.edit.commit({dryRun: context.dryRun})
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
