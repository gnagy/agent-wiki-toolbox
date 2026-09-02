/**
 * `deleteNote` — remove a note, and say what now points at nothing.
 *
 * **Inbound links are reported, not rewritten and not removed.** A `[[stem]]` with
 * no target is a placeholder, and a placeholder is the backlog signal
 * ([[toolbox-decisions]] 30) — so deleting a note deliberately leaves its inbound
 * links as a question for the author. Silently deleting them would erase the record
 * that something used to be said here.
 */
import {createContext, finish, refuse} from './context.js'

export function deleteNote(notesDir, {path, workspace, dryRun} = {}) {
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  const resource = index.get(path)
  if (!resource) {
    // Re-run: already deleted. Report the dangling links anyway, which is the
    // useful half of the answer.
    if (context.edit.exists(path)) throw refuse('deleteNote', `${path} is not an indexed note`)
    notes.push(`${path} was already deleted`)
    return finish('deleteNote', context, {notes})
  }

  const inbound = index.backlinks(path)
  if (inbound.length > 0) {
    notes.push(
      `${inbound.length} note(s) still link to ${path}; their links are now placeholders: ${inbound.join(', ')}`,
    )
  }

  const unresolved = index.edges
    .filter((edge) => edge.to === path && edge.from !== path)
    .map((edge) => ({
      from: edge.from,
      line: edge.line,
      target: path,
      reason: 'the note it pointed at was deleted',
      candidates: [],
    }))

  context.edit.remove(path)
  return finish('deleteNote', context, {unresolved, notes})
}
