/**
 * `deleteNote` — remove a note, and say what now points at nothing.
 *
 * Inbound links are reported, not rewritten and not removed. A `[[stem]]` with
 * no target becomes a placeholder, which `check` lists.
 */
import {createContext, finish, namesANote, refuse, resolveNotePath} from './context.js'

export function deleteNote(notesDir, {path, workspace, dryRun} = {}) {
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  const target = resolveNotePath(notesDir, index, path)
  if (target !== path) notes.push(`read ${path} as ${target}, relative to the notes directory`)

  const resource = index.get(target)
  if (!resource) {
    if (context.edit.exists(target)) throw refuse('deleteNote', `${target} is not an indexed note`)
    // A path this wiki has never held is a refusal. Calling it already deleted
    // reports success for a note the caller can still see on disk.
    if (!namesANote(notesDir, target)) throw refuse('deleteNote', `${path} is not a note in ${notesDir}`)
    // Re-run: already deleted. Report the dangling links anyway, which is the
    // useful half of the answer.
    notes.push(`${target} was already deleted`)
    return finish('deleteNote', context, {notes})
  }

  const inbound = index.backlinks(target)
  if (inbound.length > 0) {
    notes.push(
      `${inbound.length} note(s) still link to ${target}; their links are now placeholders: ${inbound.join(', ')}`,
    )
  }

  const unresolved = index.edges
    .filter((edge) => edge.to === target && edge.from !== target)
    .map((edge) => ({
      from: edge.from,
      line: edge.line,
      target,
      reason: 'the note it pointed at was deleted',
      candidates: [],
    }))

  context.edit.remove(target)
  return finish('deleteNote', context, {unresolved, notes})
}
