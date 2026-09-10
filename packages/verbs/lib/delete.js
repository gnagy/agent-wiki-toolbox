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
    if (!namesANote(notesDir, target)) throw refuse('deleteNote', `${path} is not a note in ${notesDir}`)
    // No note here, and nothing to be idempotent about. This used to answer `ok`
    // and call the path already deleted, which it could not know: the guard meant
    // to catch a path the wiki never held was `namesANote`, which only tests that
    // the path is inside the notes directory, so it never fired for an in-wiki
    // one and a typo came back as success. The verb cannot tell a re-run from a
    // typo and the typo is likelier, so it refuses, as `rename` and `move` do.
    // Nothing is lost: this verb never rewrote inbound links, and listing the
    // placeholders a deletion left is what `check` is for.
    throw refuse('deleteNote', `no note at ${path}`)
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
