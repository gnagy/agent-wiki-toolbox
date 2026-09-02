/**
 * `renameTag` — one tag becomes another, everywhere it appears.
 *
 * Front-matter tags only. Obsidian's inline `#tag` is deliberately not a second tag
 * vocabulary here ([[toolbox-decisions]] 8), and Foam never treated it as one
 * either, so there is nothing else to rewrite.
 */
import {editFrontmatter, sequenceItems} from '@agent-wiki-toolbox/syntax'

import {createContext, finish, parseNote, refuse, serialize} from './context.js'

export function renameTag(notesDir, {from, to, workspace, dryRun} = {}) {
  const verb = 'renameTag'
  const context = createContext(notesDir, {workspace, dryRun})
  const index = context.workspace
  const notes = []

  if (!from || !to) throw refuse(verb, 'renameTag needs both from and to')
  if (from === to) throw refuse(verb, `"${from}" and "${to}" are the same tag`)

  const carriers = index.tags.get(from) ?? []
  if (carriers.length === 0) {
    // Re-run, or a typo. Both are worth saying out loud rather than reporting
    // a silent success.
    notes.push(`no note carries the tag "${from}"`)
    return finish(verb, context, {notes})
  }

  for (const path of carriers) {
    const tree = parseNote(context, path)

    // Through the YAML document rather than through the parsed object: a rename
    // of one tag is not permission to reformat the block around it. Rewriting
    // `tags: [a, b]` as a block sequence and dropping the author's comments is
    // a change nobody asked for, and `awt fmt` leaves front matter alone for the
    // same reason.
    const changed = editFrontmatter(tree, (document) => {
      const tags = sequenceItems(document, 'tags')
      if (!tags) return false

      // A note already carrying both ends up with one, not a duplicate.
      const seen = new Set()
      tags.items = tags.items.filter((item) => {
        const next = item.value === from ? to : item.value
        if (seen.has(next)) return false
        seen.add(next)
        item.value = next
        return true
      })
    })

    if (changed) context.edit.update(path, serialize(tree))
  }

  return finish(verb, context, {notes})
}
